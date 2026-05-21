/// PE header utilities for determining executable type.
///
/// Reads the Subsystem field from a PE file's Optional Header to distinguish
/// GUI applications (subsystem 2) from console/utility programs (subsystem 3),
/// native drivers, etc.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// PE Subsystem values (from winnt.h) — only the ones we use
const IMAGE_SUBSYSTEM_UNKNOWN: u16 = 0;
const IMAGE_SUBSYSTEM_NATIVE: u16 = 1;
pub const IMAGE_SUBSYSTEM_WINDOWS_GUI: u16 = 2;
pub const IMAGE_SUBSYSTEM_WINDOWS_CUI: u16 = 3;
const IMAGE_SUBSYSTEM_NATIVE_WINDOWS: u16 = 8;

/// Result of reading a PE subsystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeKind {
    /// Windows GUI application (subsystem 2)
    GuiApp,
    /// Console / command-line application (subsystem 3)
    ConsoleApp,
    /// Native driver or system component (subsystem 1, 8)
    Native,
    /// Unknown or other subsystem
    Other(u16),
    /// File could not be read or is not a valid PE
    NotPe,
}

/// Read the PE Subsystem field from an executable file.
///
/// Only reads ~80 bytes total (DOS header → PE header → Optional header → Subsystem).
/// Returns `PeKind::NotPe` if the file cannot be read or is not a valid PE.
pub fn read_pe_subsystem(path: &Path) -> PeKind {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return PeKind::NotPe,
    };

    // ── DOS Header ──────────────────────────────────────────────
    // Offset 0x00: MZ signature (2 bytes)
    // Offset 0x3C: e_lfanew — offset to PE header (4 bytes, little-endian)
    let mut dos_buf = [0u8; 64];
    if f.read_exact(&mut dos_buf).is_err() {
        return PeKind::NotPe;
    }
    if dos_buf[0] != b'M' || dos_buf[1] != b'Z' {
        return PeKind::NotPe;
    }
    let pe_offset = u32::from_le_bytes([
        dos_buf[0x3C],
        dos_buf[0x3D],
        dos_buf[0x3E],
        dos_buf[0x3F],
    ]) as usize;

    // ── Verify PE signature ─────────────────────────────────────
    let mut pe_sig = [0u8; 4];
    if f.seek(SeekFrom::Start(pe_offset as u64)).is_err() {
        return PeKind::NotPe;
    }
    if f.read_exact(&mut pe_sig).is_err() {
        return PeKind::NotPe;
    }
    if pe_sig[0] != b'P' || pe_sig[1] != b'E' || pe_sig[2] != 0 || pe_sig[3] != 0 {
        return PeKind::NotPe;
    }

    // ── Skip COFF header (20 bytes) → Optional header ───────────
    // PE signature (4) + COFF header (20) = 24 bytes from pe_offset
    // We're already at pe_offset + 4 (after reading signature)
    // Skip remaining 20 bytes of COFF header
    if f.seek(SeekFrom::Current(20)).is_err() {
        return PeKind::NotPe;
    }

    // ── Optional Header ─────────────────────────────────────────
    // Read 70 bytes: magic (2) + ... + subsystem at offset 68
    let mut opt_buf = [0u8; 70];
    if f.read_exact(&mut opt_buf).is_err() {
        return PeKind::NotPe;
    }

    let magic = u16::from_le_bytes([opt_buf[0], opt_buf[1]]);
    // PE32  magic = 0x10b → subsystem at offset 68
    // PE32+ magic = 0x20b → subsystem at offset 68
    // (Both formats have subsystem at the same offset from optional header start)
    if magic != 0x10b && magic != 0x20b {
        return PeKind::NotPe;
    }

    let subsystem = u16::from_le_bytes([opt_buf[68], opt_buf[69]]);

    match subsystem {
        IMAGE_SUBSYSTEM_WINDOWS_GUI => PeKind::GuiApp,
        IMAGE_SUBSYSTEM_WINDOWS_CUI => PeKind::ConsoleApp,
        IMAGE_SUBSYSTEM_NATIVE | IMAGE_SUBSYSTEM_NATIVE_WINDOWS => PeKind::Native,
        IMAGE_SUBSYSTEM_UNKNOWN => PeKind::Other(0),
        other => PeKind::Other(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notepad_is_gui() {
        let notepad = Path::new(r"C:\Windows\System32\notepad.exe");
        if notepad.exists() {
            assert_eq!(read_pe_subsystem(notepad), PeKind::GuiApp);
        }
    }

    #[test]
    fn test_cmd_is_console() {
        let cmd = Path::new(r"C:\Windows\System32\cmd.exe");
        if cmd.exists() {
            assert_eq!(read_pe_subsystem(cmd), PeKind::ConsoleApp);
        }
    }

    #[test]
    fn test_non_pe_file() {
        let txt = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert_eq!(read_pe_subsystem(&txt), PeKind::NotPe);
    }
}
