//! Fixed 16px, owned monochrome mark. No remote image, path or decoding work.

pub(super) fn rgba() -> Vec<u8> {
    let mut rgba = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16 {
        for x in 0..16 {
            let ink = (3..13).contains(&x)
                && (3..13).contains(&y)
                && (x <= 4 || x >= 11 || y <= 4 || y >= 11 || (x == 7 && y >= 7));
            rgba.extend_from_slice(&[35, 35, 35, if ink { 255 } else { 0 }]);
        }
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn icon_is_static_bounded_and_has_transparent_edges() {
        let bytes = rgba();
        assert_eq!(bytes.len(), 1024);
        assert_eq!(bytes, rgba());
        assert!(
            bytes
                .chunks_exact(4)
                .all(|p| p[..3] == [35, 35, 35] && (p[3] == 0 || p[3] == 255))
        );
        assert!(bytes.chunks_exact(4).any(|p| p[3] == 255));
        assert!(bytes[..16 * 4].chunks_exact(4).all(|p| p[3] == 0));
    }
}
