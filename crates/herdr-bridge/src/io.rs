//! Transport primitives for one herdr connection (issue #329).
//!
//! A `Connection` decouples the byte stream from the read loop: the
//! connector spawns a reader thread that forwards chunks, errors, and the
//! close event over a channel, so `rpc`/`subscribe` can apply deadlines
//! uniformly on unix sockets and Windows named pipes alike.

use std::io::{self, Read, Write};
use std::sync::mpsc::{channel, Receiver};
use std::thread::JoinHandle;

/// One chunk or terminal event from a connection's read side.
#[derive(Debug)]
pub enum ConnEvent {
    Data(Vec<u8>),
    /// Transport-level failure; the stream is finished afterwards.
    Error(String),
    /// Peer closed (or local shutdown completed).
    Closed,
}

/// An established connection: write side plus an event stream.
pub struct Connection {
    pub events: Receiver<ConnEvent>,
    writer: Box<dyn Write + Send>,
    closer: Box<dyn FnMut() + Send>,
    reader: Option<JoinHandle<()>>,
}

impl Connection {
    /// Write a request frame and flush.
    pub fn write(&mut self, data: &[u8]) -> io::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    /// End the write side (half-close where supported).
    pub fn end(&mut self) {
        let _ = self.writer.flush();
        (self.closer)();
    }

    /// Consume the connection, waiting briefly for the reader thread.
    pub fn join(self) {
        if let Some(reader) = self.reader {
            let _ = reader.join();
        }
    }

    /// Assemble a `Connection` from raw parts — crate-internal
    /// transports (e.g. the ssh process pipe) that drive their own
    /// reader/supervisor loop instead of `spawn_reader`.
    pub(crate) fn from_parts(
        events: Receiver<ConnEvent>,
        writer: Box<dyn Write + Send>,
        closer: Box<dyn FnMut() + Send>,
        reader: Option<JoinHandle<()>>,
    ) -> Self {
        Self {
            events,
            writer,
            closer,
            reader,
        }
    }

    /// Split into the pieces a long-lived protocol link needs
    /// (issue #598): the event stream for the pump thread, the writer
    /// for the send thread, the transport closer, and the reader join
    /// handle. `end()`/`join()` semantics are preserved by calling
    /// `closer` then joining `reader` once the pump sees `Closed`.
    pub fn into_parts(self) -> LinkParts {
        (self.events, self.writer, self.closer, self.reader)
    }
}

/// The split pieces of a [`Connection`], see [`Connection::into_parts`].
pub type LinkParts = (
    Receiver<ConnEvent>,
    Box<dyn Write + Send>,
    Box<dyn FnMut() + Send>,
    Option<JoinHandle<()>>,
);

/// Opens one transport to a herdr endpoint. Called once per connection —
/// herdr closes the socket after each answer, so callers connect per call.
pub trait Connector: Send + Sync {
    fn connect(&self) -> Result<Connection, String>;
}

/// Spawn the reader thread that turns a `Read` half into `ConnEvent`s.
/// `closer` runs on `end()`; it should unblock the reader if the transport
/// supports half-close.
pub fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    closer: Box<dyn FnMut() + Send>,
) -> Connection {
    let (tx, rx) = channel();
    let handle = std::thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(ConnEvent::Closed);
                    break;
                }
                Ok(n) => {
                    if tx.send(ConnEvent::Data(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(ConnEvent::Error(e.to_string()));
                    break;
                }
            }
        }
    });
    Connection {
        events: rx,
        writer,
        closer,
        reader: Some(handle),
    }
}

/// Connector over a local unix socket or Windows named pipe.
pub struct SocketConnector {
    address: String,
}

impl SocketConnector {
    pub fn new(address: String) -> Self {
        Self { address }
    }
}

impl Connector for SocketConnector {
    fn connect(&self) -> Result<Connection, String> {
        platform::connect(&self.address)
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::net::UnixStream;

    pub fn connect(address: &str) -> Result<Connection, String> {
        let stream = UnixStream::connect(address)
            .map_err(|e| format!("cannot reach herdr at {address}: {e}"))?;
        let writer_stream = stream
            .try_clone()
            .map_err(|e| format!("cannot clone herdr socket: {e}"))?;
        let shutdown_stream = stream
            .try_clone()
            .map_err(|e| format!("cannot clone herdr socket: {e}"))?;
        Ok(spawn_reader(
            Box::new(stream),
            Box::new(writer_stream),
            Box::new(move || {
                let _ = shutdown_stream.shutdown(std::net::Shutdown::Both);
            }),
        ))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{DuplicateHandle, GetCurrentProcess};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::CancelIoEx;

    /// Synchronous handle wrapper: `ReadFile`/`WriteFile` block, which is
    /// fine — reads run on the reader thread, writes are small requests.
    struct PipeHandle(RawHandle);

    impl Read for PipeHandle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut read: u32 = 0;
            let ok = unsafe {
                ReadFile(
                    self.0,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    &mut read,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(read as usize)
        }
    }

    impl Write for PipeHandle {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut written: u32 = 0;
            let ok = unsafe {
                WriteFile(
                    self.0,
                    buf.as_ptr(),
                    buf.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(written as usize)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for PipeHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// `CreateFileW` on `\\.\pipe\…` blocks until the server accepts (or
    /// fails). The handle is duplicated so reader and writer halves own
    /// independent references.
    pub fn connect(address: &str) -> Result<Connection, String> {
        let wide: Vec<u16> = address.encode_utf16().chain(std::iter::once(0)).collect();
        let handle: HANDLE = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "cannot reach herdr at {address}: {}",
                io::Error::last_os_error()
            ));
        }
        let mut dup: HANDLE = std::ptr::null_mut();
        let ok = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle,
                GetCurrentProcess(),
                &mut dup,
                0,
                0,
                2, // DUPLICATE_SAME_ACCESS
            )
        };
        if ok == 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!(
                "cannot duplicate herdr pipe handle: {}",
                io::Error::last_os_error()
            ));
        }
        // `end()` cancels the blocked ReadFile on the reader thread so
        // `join` can return; the handle stays owned by PipeHandle until
        // the Connection drops after join.
        let read_handle = handle;
        Ok(spawn_reader(
            Box::new(PipeHandle(handle)),
            Box::new(PipeHandle(dup)),
            Box::new(move || unsafe {
                CancelIoEx(read_handle, std::ptr::null());
            }),
        ))
    }
}
