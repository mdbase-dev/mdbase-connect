## Fixed

- Stamp the source commit into every Editor HTML document, including the 404 page, so a header policy change such as a new Content-Security-Policy reaches documents whose content did not change instead of the CDN keeping the previous build's headers.
