import type { CommunityMeetup, ReleaseEvent } from "./types";

interface EventGroup {
  product: string;
  date: string;
  meetupUrls?: string[];
  calendarUrl?: string;
}

/** Only publisher-confirmed relationships attach a meetup to a larger event. */
export function calendarMeetupRows<T extends ReleaseEvent>(releases: T[], meetups: CommunityMeetup[], groups: EventGroup[]) {
  const rows: { date: string; release: T | null; meetups: CommunityMeetup[] }[] = releases.map((release) => ({ date: release.date, release, meetups: [] }));
  for (const meetup of meetups) {
    const parent = rows.find(({ release }) => release?.kind === "Event" && groups.some((group) =>
      group.product === release.product && group.date === release.date &&
      meetup.date >= release.date && meetup.date <= (release.endDate ?? release.date) &&
      (group.meetupUrls?.includes(meetup.url) || (group.calendarUrl && meetup.calendarUrls.includes(group.calendarUrl))),
    ));
    if (parent) parent.meetups.push(meetup);
    else {
      const dateRow = rows.find((row) => !row.release && row.date === meetup.date);
      if (dateRow) dateRow.meetups.push(meetup);
      else rows.push({ date: meetup.date, release: null, meetups: [meetup] });
    }
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date));
}
