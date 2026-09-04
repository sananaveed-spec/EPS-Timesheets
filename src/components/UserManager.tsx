import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  fetchClockifyUsers,
  type ClockifyUserSummary,
} from '../lib/clockifyApi';
import type { EmployeeCategory, ManagedUser, MentionUser } from '../types';
import { sameEmployeeName } from '../lib/employeeCategories';

interface UserManagerProps {
  users: ManagedUser[];
  mentionUsers: MentionUser[];
  onAddUsers: (names: string[], category: EmployeeCategory) => void;
  onUpdateUser: (id: string, category: EmployeeCategory) => void;
  onSyncClockifyNames: (clockifyUsers: ClockifyUserSummary[]) => void;
  onRemoveUsers: (ids: string[]) => void;
  onAddMentions: (names: string[]) => void;
  onRemoveMentions: (ids: string[]) => void;
}

const CATEGORY_LABELS: Record<EmployeeCategory, string> = {
  'full-time-salaried': 'Full-time salaried',
  'full-time-hourly': 'Full-time hourly',
  'part-time-hourly': 'Part-time hourly',
};

function firstName(fullName: string): string {
  const base = fullName.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return base.split(/\s+/)[0] || base;
}

function sameName(a: string, b: string): boolean {
  return sameEmployeeName(a, b);
}

function mentionPreview(users: MentionUser[]): string {
  const names = users.map((user) => firstName(user.name)).filter(Boolean);
  if (names.length === 0) return '';
  return `${names.join('/')}....`;
}

export function UserManager({
  users,
  mentionUsers,
  onAddUsers,
  onUpdateUser,
  onSyncClockifyNames,
  onRemoveUsers,
  onAddMentions,
  onRemoveMentions,
}: UserManagerProps) {
  const [clockifyUsers, setClockifyUsers] = useState<ClockifyUserSummary[]>(
    [],
  );
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);

  const [category, setCategory] =
    useState<EmployeeCategory>('full-time-hourly');
  const [remainingQuery, setRemainingQuery] = useState('');
  const [selectedRemainingIds, setSelectedRemainingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedSavedIds, setSelectedSavedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editCategory, setEditCategory] =
    useState<EmployeeCategory>('full-time-hourly');
  const [showSavedUsers, setShowSavedUsers] = useState(false);
  const [showMentionUsers, setShowMentionUsers] = useState(false);

  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionRemainingIds, setSelectedMentionRemainingIds] =
    useState<Set<string>>(() => new Set());
  const [selectedSavedMentionIds, setSelectedSavedMentionIds] = useState<
    Set<string>
  >(() => new Set());

  const loadClockifyUsers = useCallback(async () => {
    setLoadingUsers(true);
    setUserError(null);
    const result = await fetchClockifyUsers();
    setLoadingUsers(false);
    if (!result.success) {
      setClockifyUsers([]);
      setUserError(result.error);
      return;
    }
    setClockifyUsers(result.users);
  }, []);

  useEffect(() => {
    // Defer to avoid triggering the "setState in effect" lint rule.
    void Promise.resolve().then(() => {
      void loadClockifyUsers();
    });
  }, [loadClockifyUsers]);

  useEffect(() => {
    if (clockifyUsers.length === 0) return;
    onSyncClockifyNames(clockifyUsers);
  }, [clockifyUsers, onSyncClockifyNames]);

  const remainingUsers = useMemo(
    () =>
      clockifyUsers
        .filter(
          (employee) =>
            !users.some((user) => sameName(user.name, employee.name)),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clockifyUsers, users],
  );

  const filteredRemaining = useMemo(() => {
    const query = remainingQuery.trim().toLowerCase();
    if (!query) return remainingUsers;
    return remainingUsers.filter(
      (employee) =>
        employee.name.toLowerCase().includes(query) ||
        employee.email.toLowerCase().includes(query),
    );
  }, [remainingQuery, remainingUsers]);

  const remainingMentions = useMemo(
    () =>
      clockifyUsers
        .filter(
          (employee) =>
            !mentionUsers.some((user) => sameName(user.name, employee.name)),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clockifyUsers, mentionUsers],
  );

  const filteredRemainingMentions = useMemo(() => {
    const query = mentionQuery.trim().toLowerCase();
    if (!query) return remainingMentions;
    return remainingMentions.filter(
      (employee) =>
        employee.name.toLowerCase().includes(query) ||
        employee.email.toLowerCase().includes(query),
    );
  }, [mentionQuery, remainingMentions]);

  const sortedUsers = useMemo(
    () => [...users].sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );

  const greeting = mentionPreview(mentionUsers);

  const toggleId = useCallback(
    (id: string, setter: Dispatch<SetStateAction<Set<string>>>) => {
      setter((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

  const handleAddUsers = useCallback(() => {
    const names = remainingUsers
      .filter((employee) => selectedRemainingIds.has(employee.id))
      .map((employee) => employee.name);
    if (names.length === 0) return;
    onAddUsers(names, category);
    setSelectedRemainingIds(new Set());
  }, [category, onAddUsers, remainingUsers, selectedRemainingIds]);

  const handleDeleteUsers = useCallback(() => {
    if (selectedSavedIds.size === 0) return;
    onRemoveUsers(Array.from(selectedSavedIds));
    setSelectedSavedIds(new Set());
    setEditingUserId((current) =>
      current && selectedSavedIds.has(current) ? null : current,
    );
  }, [onRemoveUsers, selectedSavedIds]);

  const handleStartEdit = useCallback((user: ManagedUser) => {
    setEditingUserId(user.id);
    setEditCategory(user.category);
    setShowSavedUsers(true);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingUserId(null);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingUserId) return;
    onUpdateUser(editingUserId, editCategory);
    setEditingUserId(null);
  }, [editCategory, editingUserId, onUpdateUser]);

  const handleAddMentions = useCallback(() => {
    const names = remainingMentions
      .filter((employee) => selectedMentionRemainingIds.has(employee.id))
      .map((employee) => employee.name);
    if (names.length === 0) return;
    onAddMentions(names);
    setSelectedMentionRemainingIds(new Set());
  }, [onAddMentions, remainingMentions, selectedMentionRemainingIds]);

  const handleDeleteMentions = useCallback(() => {
    if (selectedSavedMentionIds.size === 0) return;
    onRemoveMentions(Array.from(selectedSavedMentionIds));
    setSelectedSavedMentionIds(new Set());
  }, [onRemoveMentions, selectedSavedMentionIds]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Manage Users</h2>
            <p className="mt-1 text-sm text-gray-600">
              Select remaining Clockify employees, choose a category, then add
              them. Saved users keep their current data unless you edit them.
            </p>
          </div>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
            {users.length} saved
          </span>
        </div>

        {loadingUsers ? (
          <p className="mt-5 text-sm text-blue-600">Loading Clockify users...</p>
        ) : userError ? (
          <div className="mt-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            <p>{userError}</p>
            <button
              type="button"
              onClick={() => {
                void loadClockifyUsers();
              }}
              className="mt-2 text-sm font-medium text-red-800 underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <form
            className="mt-5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleAddUsers();
            }}
          >
            <input
              type="search"
              value={remainingQuery}
              onChange={(event) => setRemainingQuery(event.target.value)}
              placeholder="Search remaining Clockify users"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500"
            />
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-2">
              {filteredRemaining.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-gray-500">
                  {remainingUsers.length === 0
                    ? 'All Clockify users have already been added.'
                    : `No remaining users match “${remainingQuery.trim()}”.`}
                </p>
              ) : (
                filteredRemaining.map((employee) => (
                  <label
                    key={employee.id}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-white"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRemainingIds.has(employee.id)}
                      onChange={() =>
                        toggleId(employee.id, setSelectedRemainingIds)
                      }
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
                ))
              )}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <select
                value={category}
                onChange={(event) =>
                  setCategory(event.target.value as EmployeeCategory)
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500"
              >
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={selectedRemainingIds.size === 0}
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-400"
              >
                Add User
              </button>
            </div>
          </form>
        )}

        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-800">Saved users</p>
            <button
              type="button"
              onClick={handleDeleteUsers}
              disabled={selectedSavedIds.size === 0}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-transparent"
            >
              Delete
            </button>
          </div>
          {showSavedUsers &&
            sortedUsers.map((user) => {
              const isEditing = editingUserId === user.id;
              return (
                <div
                  key={user.id}
                  className="flex flex-wrap items-start gap-3 rounded-lg border border-gray-200 px-4 py-3"
                >
                  <input
                    type="checkbox"
                    checked={selectedSavedIds.has(user.id)}
                    onChange={() => toggleId(user.id, setSelectedSavedIds)}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600"
                    aria-label={`Select ${user.name}`}
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="font-medium text-gray-900">
                      {user.name}
                    </div>
                    {isEditing ? (
                      <select
                        value={editCategory}
                        onChange={(event) =>
                          setEditCategory(
                            event.target.value as EmployeeCategory,
                          )
                        }
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500"
                      >
                        {Object.entries(CATEGORY_LABELS).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    ) : (
                      <div className="text-sm text-gray-600">
                        {CATEGORY_LABELS[user.category]}
                      </div>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSaveEdit}
                        className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-gray-800"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleStartEdit(user)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                      Edit
                    </button>
                  )}
                </div>
              );
            })}
          {sortedUsers.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSavedUsers((current) => !current)}
              className="w-full rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-50"
            >
              {showSavedUsers ? 'Hide saved users' : 'Show saved users'}
            </button>
          )}
        </div>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Comment mentions
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Choose Clockify users to mention in review comments. First names
              are used, for example Abdur/Samir....
            </p>
          </div>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
            {mentionUsers.length} saved
          </span>
        </div>

        {greeting ? (
          <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
            Comments will start with{' '}
            <span className="font-medium text-gray-900">{greeting}</span>
          </p>
        ) : (
          <p className="mt-3 text-sm text-gray-500">
            Add mention users to prefix comments with their first names.
          </p>
        )}

        {!loadingUsers && !userError && (
          <form
            className="mt-5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleAddMentions();
            }}
          >
            <input
              type="search"
              value={mentionQuery}
              onChange={(event) => setMentionQuery(event.target.value)}
              placeholder="Search Clockify users to mention"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500"
            />
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-2">
              {filteredRemainingMentions.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-gray-500">
                  {remainingMentions.length === 0
                    ? 'All Clockify users are already in the mention list.'
                    : `No remaining users match “${mentionQuery.trim()}”.`}
                </p>
              ) : (
                filteredRemainingMentions.map((employee) => (
                  <label
                    key={employee.id}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-white"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMentionRemainingIds.has(employee.id)}
                      onChange={() =>
                        toggleId(employee.id, setSelectedMentionRemainingIds)
                      }
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
                ))
              )}
            </div>
            <button
              type="submit"
              disabled={selectedMentionRemainingIds.size === 0}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              Save mentions
            </button>
          </form>
        )}

        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-800">Mention users</p>
            <button
              type="button"
              onClick={handleDeleteMentions}
              disabled={selectedSavedMentionIds.size === 0}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-transparent"
            >
              Delete
            </button>
          </div>
          {showMentionUsers &&
            mentionUsers.map((user) => (
              <label
                key={user.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 px-4 py-3"
              >
                <input
                  type="checkbox"
                  checked={selectedSavedMentionIds.has(user.id)}
                  onChange={() => toggleId(user.id, setSelectedSavedMentionIds)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                />
                <span className="font-medium text-gray-900">
                  {user.name} ({firstName(user.name)})
                </span>
              </label>
            ))}
          {mentionUsers.length > 0 && (
            <button
              type="button"
              onClick={() => setShowMentionUsers((current) => !current)}
              className="w-full rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-50"
            >
              {showMentionUsers ? 'Hide mention users' : 'Show mention users'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
