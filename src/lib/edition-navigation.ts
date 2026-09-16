export function previousEditionLabel(date: string | undefined, previousDate: string, now = new Date(), timeZone?: string): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const consecutive = date && Date.parse(`${date}T12:00:00Z`) - Date.parse(`${previousDate}T12:00:00Z`) === 86_400_000;
  return date === today && consecutive ? "Yesterday" : "Previous";
}
