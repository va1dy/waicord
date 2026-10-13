#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const BRIDGE_PORT: u16 = 8787;

static BRIDGE: Mutex<Option<Child>> = Mutex::new(None);

fn bridge_exe(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // Tauri strips the target-triple suffix when bundling external binaries.
    for name in [
        "dsmod-bridge.exe",
        "dsmod-bridge-x86_64-pc-windows-msvc.exe",
    ] {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn bridge_alive() -> bool {
    let mut stream = match TcpStream::connect_timeout(
        &format!("127.0.0.1:{BRIDGE_PORT}").parse().unwrap(),
        Duration::from_millis(250),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        Ok(n) => n > 0,
        Err(_) => false,
    }
}

fn spawn_bridge() {
    if bridge_alive() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let Some(dir) = exe.parent() else { return };
    let Some(bridge) = bridge_exe(dir) else { return };
    let mut cmd = Command::new(&bridge);
    cmd.current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(child) = cmd.spawn() {
        *BRIDGE.lock().unwrap() = Some(child);
    }
}

fn kill_bridge() {
    if let Some(mut child) = BRIDGE.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    spawn_bridge();
    tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("error while running waicord")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_bridge();
            }
        });
}
