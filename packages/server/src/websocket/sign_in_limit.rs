use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_secs(120);
const MAX_FAILURE_KEYS: usize = 4096;
const MAX_ACTIVE: usize = 4;

#[derive(Default)]
pub(super) struct SignInLimit {
    active: HashSet<IpAddr>,
    addresses: HashMap<IpAddr, Failures>,
    logins: HashMap<[u8; 32], Failures>,
}

struct Failures {
    count: u32,
    last: Instant,
    resume: Instant,
    // A single source may slow itself, but cannot lock other addresses out of a login.
    single_source: Option<IpAddr>,
}

#[derive(Debug)]
pub(super) enum Rejection {
    Busy,
    Backoff(Duration),
}

pub(super) struct Attempt {
    limiter: Arc<Mutex<SignInLimit>>,
    address: IpAddr,
    login: Option<[u8; 32]>,
}

impl Attempt {
    pub(super) fn begin(
        limiter: Arc<Mutex<SignInLimit>>,
        address: IpAddr,
    ) -> Result<Self, Rejection> {
        let address = match address.to_canonical() {
            IpAddr::V6(address) => IpAddr::V6((u128::from(address) & (!0_u128 << 64)).into()),
            ipv4 => ipv4,
        };
        let mut state = limiter.lock().expect("sign-in limit lock");
        check(state.addresses.get(&address))?;
        if state.active.len() >= MAX_ACTIVE || !state.active.insert(address) {
            return Err(Rejection::Busy);
        }
        drop(state);
        Ok(Self {
            limiter,
            address,
            login: None,
        })
    }

    pub(super) fn for_login(&mut self, method: &str, login: &str) -> Result<(), Rejection> {
        let mut hash = Sha256::new();
        hash.update(method.len().to_le_bytes());
        hash.update(method.as_bytes());
        hash.update(login.trim().to_lowercase().as_bytes());
        let key = hash.finalize().into();
        check(
            self.limiter
                .lock()
                .expect("sign-in limit lock")
                .logins
                .get(&key)
                .filter(|failures| {
                    failures
                        .single_source
                        .is_none_or(|source| source == self.address)
                }),
        )?;
        self.login = Some(key);
        Ok(())
    }

    pub(super) fn rejected(&self) {
        let mut state = self.limiter.lock().expect("sign-in limit lock");
        let now = Instant::now();
        failure(&mut state.addresses, self.address, self.address, 6, now);
        if let Some(login) = self.login {
            failure(&mut state.logins, login, self.address, 3, now);
        }
    }

    pub(super) fn accepted(&self) {
        // Success on one account must not erase an address's failures on others.
        if let Some(login) = self.login {
            self.limiter
                .lock()
                .expect("sign-in limit lock")
                .logins
                .remove(&login);
        }
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        self.limiter
            .lock()
            .expect("sign-in limit lock")
            .active
            .remove(&self.address);
    }
}

fn check(failures: Option<&Failures>) -> Result<(), Rejection> {
    match failures.and_then(|failures| failures.resume.checked_duration_since(Instant::now())) {
        Some(delay) => Err(Rejection::Backoff(delay)),
        None => Ok(()),
    }
}

fn failure<K: Copy + Eq + Hash>(
    entries: &mut HashMap<K, Failures>,
    key: K,
    source: IpAddr,
    burst: u32,
    now: Instant,
) {
    if entries.len() >= MAX_FAILURE_KEYS && !entries.contains_key(&key) {
        entries.retain(|_, entry| now.duration_since(entry.last) < WINDOW);
        if entries.len() >= MAX_FAILURE_KEYS
            && let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.last)
                .map(|(key, _)| *key)
        {
            entries.remove(&oldest);
        }
    }
    let entry = entries.entry(key).or_insert(Failures {
        count: 0,
        last: now,
        resume: now,
        single_source: Some(source),
    });
    if now.duration_since(entry.last) >= WINDOW {
        entry.count = 0;
        entry.single_source = Some(source);
    }
    if entry.single_source != Some(source) {
        entry.single_source = None;
    }
    entry.count = entry.count.saturating_add(1);
    entry.last = now;
    entry.resume = if entry.count < burst {
        now
    } else {
        now + Duration::from_secs(1 << (entry.count - burst).min(4))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv6_addresses_in_one_prefix_share_a_slot_and_backoff() {
        let limit = Arc::new(Mutex::new(SignInLimit::default()));
        let a = "2001:db8:1:2::1".parse().unwrap();
        let b = "2001:db8:1:2::2".parse().unwrap();
        let other = "2001:db8:1:3::1".parse().unwrap();
        let active = Attempt::begin(limit.clone(), a).unwrap();
        assert!(matches!(
            Attempt::begin(limit.clone(), b),
            Err(Rejection::Busy)
        ));
        assert!(Attempt::begin(limit.clone(), other).is_ok());
        drop(active);
        for _ in 0..6 {
            Attempt::begin(limit.clone(), a).unwrap().rejected();
        }
        assert!(matches!(
            Attempt::begin(limit.clone(), b),
            Err(Rejection::Backoff(_))
        ));
        assert!(Attempt::begin(limit, other).is_ok());
    }

    #[test]
    fn noisy_address_gets_one_slot_and_cannot_escape_backoff_by_changing_login() {
        let limit = Arc::new(Mutex::new(SignInLimit::default()));
        let noisy = "192.0.2.1".parse().unwrap();
        let other = "192.0.2.2".parse().unwrap();
        let active = Attempt::begin(limit.clone(), noisy).unwrap();
        assert!(matches!(
            Attempt::begin(limit.clone(), noisy),
            Err(Rejection::Busy)
        ));
        assert!(Attempt::begin(limit.clone(), other).is_ok());
        drop(active);
        for login in ["one", "two", "three", "four", "five", "six"] {
            let mut attempt = Attempt::begin(limit.clone(), noisy).unwrap();
            attempt.for_login("password", login).unwrap();
            attempt.rejected();
        }
        assert!(matches!(
            Attempt::begin(limit.clone(), noisy),
            Err(Rejection::Backoff(_))
        ));
        assert!(Attempt::begin(limit, other).is_ok());
    }
    #[test]
    fn login_backoff_crosses_addresses_only_after_failures_from_several_sources() {
        let limit = Arc::new(Mutex::new(SignInLimit::default()));
        let a = "192.0.2.1".parse().unwrap();
        let b = "192.0.2.2".parse().unwrap();
        for _ in 0..3 {
            let mut attempt = Attempt::begin(limit.clone(), a).unwrap();
            attempt.for_login("password", "  Alice ").unwrap();
            attempt.rejected();
        }
        assert!(matches!(
            Attempt::begin(limit.clone(), a)
                .unwrap()
                .for_login("password", "alice"),
            Err(Rejection::Backoff(_))
        ));
        let mut another = Attempt::begin(limit.clone(), b).unwrap();
        another.for_login("password", "alice").unwrap();
        another.rejected();
        let third = "192.0.2.3".parse().unwrap();
        assert!(matches!(
            Attempt::begin(limit, third)
                .unwrap()
                .for_login("password", "alice"),
            Err(Rejection::Backoff(_))
        ));
    }
}
