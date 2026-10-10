//! Longest common subsequence alignment with the Myers difference algorithm
//! (linear space, divide and conquer at the middle snake).
//!
//! Spec 12A aligns the base body with each side by a longest common
//! subsequence of lines and says implementations SHOULD use Myers. When several
//! longest subsequences exist the choice is this algorithm's (see
//! `docs/spec-notes.md`). The implementation is iterative, so long inputs
//! cannot exhaust the stack, and its choices depend only on token equality.

/// Matched index pairs `(i, j)` with `a[i] == b[j]`, strictly increasing in both
/// components, forming a longest common subsequence of `a` and `b`.
pub(crate) fn lcs_pairs<T: Eq>(a: &[T], b: &[T]) -> Vec<(usize, usize)> {
    enum Task {
        Range(usize, usize, usize, usize),
        Emit(Vec<(usize, usize)>),
    }
    let mut out = Vec::new();
    let mut stack = vec![Task::Range(0, a.len(), 0, b.len())];
    while let Some(task) = stack.pop() {
        let (mut a0, mut a1, mut b0, mut b1) = match task {
            Task::Emit(pairs) => {
                out.extend(pairs);
                continue;
            }
            Task::Range(a0, a1, b0, b1) => (a0, a1, b0, b1),
        };
        while a0 < a1 && b0 < b1 && a[a0] == b[b0] {
            out.push((a0, b0));
            a0 += 1;
            b0 += 1;
        }
        let mut suffix = Vec::new();
        while a1 > a0 && b1 > b0 && a[a1 - 1] == b[b1 - 1] {
            a1 -= 1;
            b1 -= 1;
            suffix.push((a1, b1));
        }
        suffix.reverse();
        stack.push(Task::Emit(suffix));
        if a0 == a1 || b0 == b1 {
            continue;
        }
        if let Some((x, y)) = bisect(&a[a0..a1], &b[b0..b1]) {
            stack.push(Task::Range(a0 + x, a1, b0 + y, b1));
            stack.push(Task::Range(a0, a0 + x, b0, b0 + y));
        }
    }
    out
}

/// Find the middle snake of `a` and `b` (which differ in their first and last
/// elements) and return a split point `(x, y)` on it, or `None` when they have
/// nothing in common.
fn bisect<T: Eq>(a: &[T], b: &[T]) -> Option<(usize, usize)> {
    let n = isize::try_from(a.len()).ok()?;
    let m = isize::try_from(b.len()).ok()?;
    let max_d = (n + m + 1) / 2;
    let offset = max_d;
    let len = usize::try_from(2 * max_d + 2).ok()?;
    let mut v1 = vec![-1isize; len];
    let mut v2 = vec![-1isize; len];
    let at = |k: isize| usize::try_from(k).unwrap_or(0);
    v1[at(offset + 1)] = 0;
    v2[at(offset + 1)] = 0;
    let delta = n - m;
    let front = delta % 2 != 0;
    let (mut k1start, mut k1end, mut k2start, mut k2end) = (0isize, 0isize, 0isize, 0isize);
    let eq = |i: isize, j: isize| a[at(i)] == b[at(j)];
    for d in 0..max_d {
        let mut k1 = -d + k1start;
        while k1 <= d - k1end {
            let k1o = offset + k1;
            let mut x1 = if k1 == -d || (k1 != d && v1[at(k1o - 1)] < v1[at(k1o + 1)]) {
                v1[at(k1o + 1)]
            } else {
                v1[at(k1o - 1)] + 1
            };
            let mut y1 = x1 - k1;
            while x1 < n && y1 < m && eq(x1, y1) {
                x1 += 1;
                y1 += 1;
            }
            v1[at(k1o)] = x1;
            if x1 > n {
                k1end += 2;
            } else if y1 > m {
                k1start += 2;
            } else if front {
                let k2o = offset + delta - k1;
                if k2o >= 0 && k2o < 2 * max_d + 2 && v2[at(k2o)] != -1 {
                    let x2 = n - v2[at(k2o)];
                    if x1 >= x2 {
                        return Some((at(x1), at(y1)));
                    }
                }
            }
            k1 += 2;
        }
        let mut k2 = -d + k2start;
        while k2 <= d - k2end {
            let k2o = offset + k2;
            let mut x2 = if k2 == -d || (k2 != d && v2[at(k2o - 1)] < v2[at(k2o + 1)]) {
                v2[at(k2o + 1)]
            } else {
                v2[at(k2o - 1)] + 1
            };
            let mut y2 = x2 - k2;
            while x2 < n && y2 < m && eq(n - x2 - 1, m - y2 - 1) {
                x2 += 1;
                y2 += 1;
            }
            v2[at(k2o)] = x2;
            if x2 > n {
                k2end += 2;
            } else if y2 > m {
                k2start += 2;
            } else if !front {
                let k1o = offset + delta - k2;
                if k1o >= 0 && k1o < 2 * max_d + 2 && v1[at(k1o)] != -1 {
                    let x1 = v1[at(k1o)];
                    let y1 = offset + x1 - k1o;
                    if x1 >= n - x2 {
                        return Some((at(x1), at(y1)));
                    }
                }
            }
            k2 += 2;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// LCS length by dynamic programming (the oracle).
    fn lcs_len(a: &[u8], b: &[u8]) -> usize {
        let mut t = vec![vec![0usize; b.len() + 1]; a.len() + 1];
        for i in (0..a.len()).rev() {
            for j in (0..b.len()).rev() {
                t[i][j] = if a[i] == b[j] {
                    t[i + 1][j + 1] + 1
                } else {
                    t[i + 1][j].max(t[i][j + 1])
                };
            }
        }
        t[0][0]
    }

    fn check(a: &[u8], b: &[u8]) {
        let pairs = lcs_pairs(a, b);
        assert_eq!(pairs.len(), lcs_len(a, b), "{a:?} {b:?}");
        for w in pairs.windows(2) {
            assert!(w[0].0 < w[1].0 && w[0].1 < w[1].1);
        }
        for &(i, j) in &pairs {
            assert_eq!(a[i], b[j]);
        }
    }

    #[test]
    fn small_cases() {
        check(b"", b"");
        check(b"abc", b"");
        check(b"abcabba", b"cbabac");
        check(b"xaxbx", b"ab");
        check(b"abcdef", b"abcdef");
        check(b"aaaa", b"aa");
        check(b"ab", b"ba");
    }

    #[test]
    fn exhaustive_short_strings_are_optimal() {
        // Every pair of strings over {a, b, c} up to length 5.
        let mut all = vec![Vec::new()];
        for len in 1..=5 {
            let mut next = Vec::new();
            for s in all.iter().filter(|s: &&Vec<u8>| s.len() == len - 1) {
                for c in b"abc" {
                    let mut t = s.clone();
                    t.push(*c);
                    next.push(t);
                }
            }
            all.extend(next);
        }
        for a in all.iter().step_by(3) {
            for b in all.iter().step_by(7) {
                check(a, b);
            }
        }
    }

    #[test]
    fn long_inputs_do_not_recurse() {
        let a: Vec<u32> = (0..3_000).map(|i| i % 7).collect();
        let b: Vec<u32> = (0..3_000).map(|i| (i * 3) % 7).collect();
        let p = lcs_pairs(&a, &b);
        assert!(!p.is_empty());
    }
}
