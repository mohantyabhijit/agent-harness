export function isExactSingleLineText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim().length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127 || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

export function isExactMultilineText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim().length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10) continue;
    if (code === 13) {
      if (value.charCodeAt(index + 1) !== 10) return false;
      continue;
    }
    if (code < 32 || code === 127) return false;
  }
  return true;
}
