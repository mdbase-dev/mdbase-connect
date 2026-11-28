/** @param {string} message @param {string} [code] */
export function isDiagnosticMessage(message, code) {
  const text = message.trim();
  return !text || text === code || /^[a-z\d]+(?:_[a-z\d]+)+$/i.test(text) || /^request failed with http \d+\.?$/i.test(text);
}
