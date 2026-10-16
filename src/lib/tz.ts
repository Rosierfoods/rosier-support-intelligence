export function formatInTimeZone(d: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-IN', { timeZone, ...opts }).format(d);
}
