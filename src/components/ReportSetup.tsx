import { useCallback, useMemo, useState } from 'react';
import {
  fetchClockifyUsers,
  type ClockifyUserSummary,
} from '../lib/clockifyApi';
import { sameEmployeeName } from '../lib/employeeCategories';
import { sameClockifyPerson } from '../lib/clockifyPeople';
import type { ManagedUser, OfficeCategory } from '../types';

interface ReportSetupProps {
  onFetch: (
    startDate: string,
    endDate: string,
    employeeNames: string[],
  ) => void;
  savedUsers: ManagedUser[];
  officeCategories: OfficeCategory[];
  disabled?: boolean;
}

type SetupStep = 'dates' | 'employees';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonthIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function buildSelectableEmployees(
  savedUsers: ManagedUser[],
  clockifyUsers: ClockifyUserSummary[],
): ClockifyUserSummary[] {
  return savedUsers
    .map((user) => {
      const match =
        (user.clockifyUserId &&
          clockifyUsers.find((employee) => employee.id === user.clockifyUserId)) ||
        clockifyUsers.find((employee) =>
          sameEmployeeName(employee.name, user.name),
        );
      // Always prefer the live Clockify name/id when available.
      return {
        id: match?.id ?? user.clockifyUserId ?? user.id,
        name: match?.name ?? user.name,
        email: match?.email ?? '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function ReportSetup({
  onFetch,
  savedUsers,
  officeCategories,
  disabled,
}: ReportSetupProps) {
  const [step, setStep] = useState<SetupStep>('dates');
  const [startDate, setStartDate] = useState(firstOfMonthIso);
  const [endDate, setEndDate] = useState(todayIso);
  const [employees, setEmployees] = useState<ClockifyUserSummary[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [employeeError, setEmployeeError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const canSubmitDates = useMemo(() => {
    if (!startDate || !endDate) return false;
    return startDate <= endDate;
  }, [startDate, endDate]);

  const sortedEmployees = useMemo(
    () => [...employees].sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  );

  const filteredEmployees = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sortedEmployees;
    return sortedEmployees.filter(
      (employee) =>
        employee.name.toLowerCase().includes(query) ||
        employee.email.toLowerCase().includes(query),
    );
  }, [searchQuery, sortedEmployees]);

  const allFilteredSelected =
    filteredEmployees.length > 0 &&
    filteredEmployees.every((employee) => selectedNames.has(employee.name));
  const someFilteredSelected =
    filteredEmployees.some((employee) => selectedNames.has(employee.name)) &&
    !allFilteredSelected;

  const allSelected =
    sortedEmployees.length > 0 &&
    selectedNames.size === sortedEmployees.length;
  const someSelected =
    selectedNames.size > 0 && selectedNames.size < sortedEmployees.length;

  const handleDatesNext = useCallback(async () => {
    if (!canSubmitDates || disabled || loadingEmployees) return;

    setEmployeeError(null);
    setLoadingEmployees(true);

    if (savedUsers.length === 0) {
      setLoadingEmployees(false);
      setEmployeeError(
        'Add employees in Manage Users first. Only saved users can be selected.',
      );
      return;
    }

    const result = await fetchClockifyUsers();
    setLoadingEmployees(false);

    if (!result.success) {
      setEmployeeError(result.error);
      return;
    }

    const selectable = buildSelectableEmployees(savedUsers, result.users);
    setEmployees(selectable);
    setSelectedNames(new Set(selectable.map((user) => user.name)));
    setSearchQuery('');
    setStep('employees');
  }, [canSubmitDates, disabled, loadingEmployees, savedUsers]);

  const handleToggleEmployee = useCallback((name: string) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    const visibleNames = filteredEmployees.map((employee) => employee.name);
    setSelectedNames((current) => {
      const next = new Set(current);
      const allVisibleSelected = visibleNames.every((name) => next.has(name));
      if (allVisibleSelected) {
        for (const name of visibleNames) next.delete(name);
      } else {
        for (const name of visibleNames) next.add(name);
      }
      return next;
    });
  }, [filteredEmployees]);

  const handleToggleAllEmployees = useCallback(() => {
    setSelectedNames((current) => {
      if (current.size === sortedEmployees.length) {
        return new Set();
      }
      return new Set(sortedEmployees.map((employee) => employee.name));
    });
  }, [sortedEmployees]);

  /** Managed users that also belong to an office — match by Clockify id/name. */
  const officeSelectableNames = useMemo(() => {
    const byOfficeId = new Map<string, string[]>();
    for (const office of officeCategories) {
      const names: string[] = [];
      const seen = new Set<string>();

      for (const member of office.members) {
        const match = sortedEmployees.find((employee) =>
          sameClockifyPerson(
            {
              clockifyUserId: member.clockifyUserId,
              name: member.name,
            },
            { clockifyUserId: employee.id, name: employee.name },
          ),
        );

        if (match && !seen.has(match.name)) {
          seen.add(match.name);
          names.push(match.name);
        }
      }

      byOfficeId.set(office.id, names);
    }
    return byOfficeId;
  }, [officeCategories, sortedEmployees]);

  const sortedOfficeCategories = useMemo(
    () => [...officeCategories].sort((a, b) => a.name.localeCompare(b.name)),
    [officeCategories],
  );

  const handleToggleOfficeCategory = useCallback(
    (officeId: string) => {
      const names = officeSelectableNames.get(officeId) ?? [];
      if (names.length === 0) return;
      setSelectedNames((current) => {
        const next = new Set(current);
        const allSelected = names.every((name) => next.has(name));
        if (allSelected) {
          for (const name of names) next.delete(name);
        } else {
          for (const name of names) next.add(name);
        }
        return next;
      });
    },
    [officeSelectableNames],
  );

  const handleEmployeesNext = useCallback(() => {
    const names = sortedEmployees
      .filter((employee) => selectedNames.has(employee.name))
      .map((employee) => employee.name)
      .sort();
    if (disabled || names.length === 0) return;
    onFetch(startDate, endDate, names);
  }, [disabled, endDate, onFetch, selectedNames, sortedEmployees, startDate]);

  const handleBack = useCallback(() => {
    setStep('dates');
    setEmployeeError(null);
    setSearchQuery('');
  }, []);

  if (step === 'dates') {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-5">
        <p className="mb-1 text-sm font-medium text-gray-800">
          Step 1: Select a date range
        </p>
        <p className="mb-4 text-xs text-gray-600">
          Choose the Clockify Detailed View period, then pick saved users on the
          next step.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm text-gray-600">
            Start date
            <input
              type="date"
              id="start-date"
              value={startDate}
              max={endDate || undefined}
              disabled={disabled || loadingEmployees}
              onChange={(event) => setStartDate(event.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-800 shadow-sm disabled:bg-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-gray-600">
            End date
            <input
              type="date"
              id="end-date"
              value={endDate}
              min={startDate || undefined}
              disabled={disabled || loadingEmployees}
              onChange={(event) => setEndDate(event.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-800 shadow-sm disabled:bg-gray-100"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              void handleDatesNext();
            }}
            disabled={disabled || loadingEmployees || !canSubmitDates}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
          >
            {loadingEmployees ? 'Loading employees...' : 'Next'}
          </button>
        </div>
        {!canSubmitDates && startDate && endDate && startDate > endDate && (
          <p className="mt-3 text-xs text-red-600">
            Start date must be on or before end date.
          </p>
        )}
        {employeeError && (
          <p className="mt-3 text-xs text-red-600">{employeeError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-800">
            Step 2: Select employees
          </p>
          <p className="mt-1 text-xs text-gray-600">
            {startDate} to {endDate}. Showing {sortedEmployees.length} saved
            user{sortedEmployees.length === 1 ? '' : 's'} from Manage Users.
          </p>
        </div>
        <button
          type="button"
          onClick={handleBack}
          disabled={disabled}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Back
        </button>
      </div>

      <div className="mb-3">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3-3" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            disabled={disabled}
            placeholder="Search saved users"
            className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-10 pr-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-100"
          />
        </div>
      </div>

      <div className="mb-3 space-y-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
            <input
              type="checkbox"
              checked={searchQuery.trim() ? allFilteredSelected : allSelected}
              ref={(input) => {
                if (input) {
                  input.indeterminate = searchQuery.trim()
                    ? someFilteredSelected
                    : someSelected;
                }
              }}
              disabled={disabled || filteredEmployees.length === 0}
              onChange={
                searchQuery.trim() ? handleToggleAll : handleToggleAllEmployees
              }
              className="h-4 w-4 rounded border-gray-300 text-blue-600"
            />
            {searchQuery.trim() ? 'Select all shown' : 'Select all'}
          </label>
          <span className="text-xs text-gray-500">
            {selectedNames.size} of {sortedEmployees.length} selected
            {searchQuery.trim() &&
              ` · ${filteredEmployees.length} shown`}
          </span>
        </div>

        {sortedOfficeCategories.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-gray-100 pt-2">
            {sortedOfficeCategories.map((office) => {
              const names = officeSelectableNames.get(office.id) ?? [];
              const allOfficeSelected =
                names.length > 0 &&
                names.every((name) => selectedNames.has(name));
              const someOfficeSelected =
                names.some((name) => selectedNames.has(name)) &&
                !allOfficeSelected;

              return (
                <label
                  key={office.id}
                  className="flex items-center gap-2 text-sm font-medium text-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={allOfficeSelected}
                    ref={(input) => {
                      if (input) input.indeterminate = someOfficeSelected;
                    }}
                    disabled={disabled || names.length === 0}
                    onChange={() => handleToggleOfficeCategory(office.id)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600"
                  />
                  <span>
                    {office.name}
                    <span className="ml-1 font-normal text-gray-500">
                      ({names.length}
                      {office.members.length !== names.length
                        ? ` of ${office.members.length}`
                        : ''}{' '}
                      in Manage Users)
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-gray-200 bg-white p-3">
        {filteredEmployees.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-gray-500">
            No saved users match &ldquo;{searchQuery.trim()}&rdquo;.
          </p>
        ) : (
          filteredEmployees.map((employee) => {
          const checked = selectedNames.has(employee.name);
          return (
            <label
              key={employee.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => handleToggleEmployee(employee.name)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900">
                  {employee.name}
                </span>
                {employee.email && (
                  <span className="block truncate text-xs text-gray-500">
                    {employee.email}
                  </span>
                )}
              </span>
            </label>
          );
        })
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleEmployeesNext}
          disabled={disabled || selectedNames.size === 0}
          className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          Next
        </button>
        {selectedNames.size === 0 && (
          <p className="text-xs text-red-600">
            Select at least one employee to continue.
          </p>
        )}
      </div>
    </div>
  );
}
