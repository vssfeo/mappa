//! Screen idle inhibitor for field mode.
//!
//! On Linux the shell keeps a `systemd-inhibit` child alive while field mode
//! asks for it; on Windows it asks the OS for an execution-state lease.

use tauri::State;

/// Holds the inhibitor process, if any.
#[derive(Default)]
pub struct ScreenAwake {
    #[cfg(unix)]
    child: std::sync::Mutex<Option<std::process::Child>>,
}

#[cfg(unix)]
impl Drop for ScreenAwake {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            platform::stop(child.as_mut());
            *child = None;
        }
    }
}

/// Enables or disables the idle inhibitor.
#[tauri::command]
pub async fn set_screen_awake(state: State<'_, ScreenAwake>, awake: bool) -> Result<(), String> {
    platform::set(state.inner(), awake)
}

#[cfg(unix)]
mod platform {
    use std::process::{Child, Command, Stdio};

    use super::ScreenAwake;

    pub fn set(state: &ScreenAwake, awake: bool) -> Result<(), String> {
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

    pub(super) fn stop(child: Option<&mut Child>) {
        if let Some(child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Power::{
        ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
    };

    use super::ScreenAwake;

    pub fn set(_state: &ScreenAwake, awake: bool) -> Result<(), String> {
        let mut flags = ES_CONTINUOUS;
        if awake {
            flags |= ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED;
        }
        let result = unsafe { SetThreadExecutionState(flags) };
        if result == 0 {
            Err("cannot change the Windows execution state".to_owned())
        } else {
            Ok(())
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use super::ScreenAwake;

    pub fn set(_state: &ScreenAwake, _awake: bool) -> Result<(), String> {
        Ok(())
    }
}
