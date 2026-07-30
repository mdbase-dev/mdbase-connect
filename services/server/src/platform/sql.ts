export function sqlPlaceholders(count: number, offset = 0): string {
  return Array.from(
    { length: count },
    (_, index) => `$${index + offset + 1}`
  ).join(", ");
}
