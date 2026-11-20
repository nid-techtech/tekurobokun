// 子プロセスをまとめるWindowsのJob Object（imple 3節）。
// サービスごとに1つ作り、JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSEを付ける。
// 停止はジョブごと終了する（サービスが起動した孫のプロセスも残さない）。
// ランチャーが閉じても落ちても、ハンドルが閉じられて、ジョブの中のプロセスはOSが終了する。
// Windows以外では、子プロセスだけを終了する（開発用）。

use std::process::Child;

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // ハンドルはどのスレッドから使ってもよい。
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> io::Result<Job> {
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;
    use std::process::Child;

    pub struct Job;

    impl Job {
        pub fn new() -> io::Result<Job> {
            Ok(Job)
        }
        pub fn assign(&self, _child: &Child) -> io::Result<()> {
            Ok(())
        }
        pub fn terminate(&self) {}
    }
}

pub use imp::Job;

/// 子プロセスをジョブに入れて持つ。
pub struct Process {
    pub child: Child,
    job: Option<Job>,
}

impl Process {
    /// ジョブを作って子プロセスを入れる。入れられなくても、子プロセスは持つ（停止は子プロセスだけになる）。
    pub fn adopt(child: Child) -> (Process, Option<String>) {
        match Job::new().and_then(|job| job.assign(&child).map(|_| job)) {
            Ok(job) => (
                Process {
                    child,
                    job: Some(job),
                },
                None,
            ),
            Err(e) => (Process { child, job: None }, Some(e.to_string())),
        }
    }

    /// ジョブごと終了し、子プロセスが終わるのを待つ。
    pub fn kill(mut self) {
        if let Some(job) = &self.job {
            job.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn kills_the_process_tree() {
        // cmdが起動したpingごと終了できること。
        let child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let (process, err) = Process::adopt(child);
        assert!(err.is_none(), "{err:?}");
        let pid = process.child.id();
        process.kill();
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()));
    }
}
