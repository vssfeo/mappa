//! Screen idle inhibitor for field mode.
//!
//! WebKitGTK does not expose the Screen Wake Lock API, so the desktop shell
//! keeps a `systemd-inhibit` child alive while field mode asks for it. Killing
//! the child releases the inhibitor; no polling or extra dependency is needed.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::State;

/// Holds the inhibitor process, if any.
#[derive(Default)]
pub struct ScreenAwake {
    child: Mutex<Option<Child>>,
}

impl Drop for ScreenAwake {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            stop(child.as_mut());
            *child = None;
        }
    }
}

/// Enables or disables the idle inhibitor.
#[tauri::command]
pub async fn set_screen_awake(state: State<'_, ScreenAwake>, awake: bool) -> Result<(), String> {
    let mut child = state
        .child
        .lock()
        .map_err(|_| "screen inhibitor mutex is poisoned".to_owned())?;
    if awake {
        if child.as_mut().is_some_and(|process| {
            process
                .try_wait()
                .map(|status| status.is_none())
                .unwrap_or(false)
        }) {
            return Ok(());
        }
        stop(child.as_mut());
        *child = Some(
            Command::new("systemd-inhibit")
                .args([
                    "--what=idle",
                    "--who=Mappa",
                    "--why=Field mode keeps the screen awake",
                    "sleep",
                    "infinity",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("cannot start systemd-inhibit: {error}"))?,
        );
        Ok(())
    } else {
        stop(child.as_mut());
        *child = None;
        Ok(())
    }
}

fn stop(child: Option<&mut Child>) {
    if let Some(child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}
