import type {
  ManagedUser,
  MentionUser,
  OfficeCategory,
} from '../types';
import { sameEmployeeName } from './employeeCategories';

export type ClockifyPerson = {
  id: string;
  name: string;
  email?: string;
};

export function findClockifyPerson(
  clockifyUsers: ClockifyPerson[],
  candidate: { clockifyUserId?: string; name: string },
): ClockifyPerson | undefined {
  if (candidate.clockifyUserId) {
    const byId = clockifyUsers.find(
      (user) => user.id === candidate.clockifyUserId,
    );
    if (byId) return byId;
  }
  return clockifyUsers.find((user) =>
    sameEmployeeName(user.name, candidate.name),
  );
}

/** Rewrite saved names to the live Clockify display name + id. */
export function alignManagedUsersToClockify(
  users: ManagedUser[],
  clockifyUsers: ClockifyPerson[],
): ManagedUser[] {
  let changed = false;
  const next = users.map((user) => {
    const match = findClockifyPerson(clockifyUsers, user);
    if (!match) return user;
    if (
      match.name === user.name &&
      match.id === user.clockifyUserId
    ) {
      return user;
    }
    changed = true;
    return {
      ...user,
      name: match.name,
      clockifyUserId: match.id,
    };
  });
  return changed ? next : users;
}

export function alignMentionUsersToClockify(
  users: MentionUser[],
  clockifyUsers: ClockifyPerson[],
): MentionUser[] {
  let changed = false;
  const next = users.map((user) => {
    const match = findClockifyPerson(clockifyUsers, user);
    if (!match) return user;
    if (
      match.name === user.name &&
      match.id === user.clockifyUserId
    ) {
      return user;
    }
    changed = true;
    return {
      ...user,
      name: match.name,
      clockifyUserId: match.id,
    };
  });
  return changed ? next : users;
}

export function alignOfficeMembersToClockify(
  offices: OfficeCategory[],
  clockifyUsers: ClockifyPerson[],
): OfficeCategory[] {
  let changed = false;
  const next = offices.map((office) => {
    let officeChanged = false;
    const members = office.members.map((member) => {
      const match = findClockifyPerson(clockifyUsers, member);
      if (!match) return member;
      if (
        match.name === member.name &&
        match.id === member.clockifyUserId
      ) {
        return member;
      }
      officeChanged = true;
      changed = true;
      return {
        ...member,
        name: match.name,
        clockifyUserId: match.id,
      };
    });
    return officeChanged ? { ...office, members } : office;
  });
  return changed ? next : offices;
}

export function sameClockifyPerson(
  a: { clockifyUserId?: string; name: string },
  b: { clockifyUserId?: string; name: string },
): boolean {
  if (a.clockifyUserId && b.clockifyUserId) {
    return a.clockifyUserId === b.clockifyUserId;
  }
  return sameEmployeeName(a.name, b.name);
}
