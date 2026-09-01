export interface HacsPullRequestSignal {
  repository: string;
  title: string;
  labels: string[];
}

const defaultRepositoryLabel = "new default repository";

export function isHacsIndexAddition(record: HacsPullRequestSignal): boolean {
  return record.repository.toLowerCase() === "hacs/default"
    && (record.labels.some((label) => label.trim().toLowerCase() === defaultRepositoryLabel)
      || /^adds new (?:integration|plugin|theme|python[ _]script|appdaemon|template)\b/i.test(record.title.trim()));
}

export function isHacsIntegrationAddition(record: HacsPullRequestSignal): boolean {
  return isHacsIndexAddition(record) && /^adds new integration\b/i.test(record.title.trim());
}

export function hacsNewIntegrationSearchQuery(start: Date, end: Date): string {
  return `repo:hacs/default is:public is:pr is:merged label:"New default repository" in:title "Adds new integration" merged:${start.toISOString()}..${end.toISOString()}`;
}
