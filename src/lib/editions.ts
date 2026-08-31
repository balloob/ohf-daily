import type { Edition } from "./types";

const files = import.meta.glob<{ default: Edition }>("../../data/editions/*.json", {
  eager: true,
});

export const editions = Object.entries(files)
  .map(([path, module]) => ({ ...module.default, _path: path }))
  .sort((a, b) => b.date.localeCompare(a.date));

export function getLatestEdition(): Edition | undefined {
  return editions[0];
}

export function getEdition(date: string): Edition | undefined {
  return editions.find((edition) => edition.date === date);
}

export function editionUrl(date: string): string {
  return `/edition/${date}/`;
}

export function formatEditionDate(date: string): string {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}
