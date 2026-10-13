// Single source of truth for PDS types, statuses, roles and limits (PRD v2 §5, §8, §9.3, §10.3, §11).
// The client reads these through GET /api/config.

export const PDS_TYPES = [
  { key: 'software', label: 'Software', blurb: 'An app, website or tool you want built' },
  { key: 'automation', label: 'Automation', blurb: 'A manual or repetitive task to automate' },
  { key: 'problem', label: 'Problem', blurb: 'An issue you are stuck on' },
  { key: 'idea', label: 'Idea', blurb: 'Something new you want to build' },
  { key: 'other', label: 'Other', blurb: 'Anything else' },
];
export const TYPE_KEYS = PDS_TYPES.map((t) => t.key);

export const URGENCY = ['Low', 'Medium', 'High'];

// PRD §11 status flow. label = what everyone sees.
export const STATUSES = {
  draft: { label: 'Draft' },
  submitted: { label: 'Submitted' },
  under_review: { label: 'Under Review' },
  need_info: { label: 'Need More Info' },
  approved: { label: 'Approved' },
  queued: { label: 'Scheduled' },
  in_development: { label: 'In Development' },
  testing: { label: 'Testing' },
  delivered: { label: 'Delivered' },
  closed: { label: 'Closed' },
  rejected: { label: 'Rejected' },
  withdrawn: { label: 'Withdrawn' },
};
export const STATUS_KEYS = Object.keys(STATUSES);
export const FINAL_STATUSES = ['closed', 'rejected', 'withdrawn'];
// "Open" for the 3-open-PDS limit (PF-06): submitted and not finished.
export const OPEN_STATUSES = STATUS_KEYS.filter((s) => s !== 'draft' && !FINAL_STATUSES.includes(s));
// PF-04: owner can edit until the admin starts review.
export const EDITABLE_STATUSES = ['draft', 'submitted'];
export const WITHDRAWABLE_STATUSES = ['draft', 'submitted', 'under_review', 'need_info', 'approved', 'queued'];

// Admin-panel status moves (who may set which status - PRD §11 "Who changes it").
export const ADMIN_SETTABLE = ['under_review', 'need_info', 'approved', 'in_development', 'testing', 'delivered', 'rejected'];
export const TEAM_SETTABLE = ['testing'];

export const COMMENT_TYPES = [
  { key: 'idea', label: 'Idea' },
  { key: 'point', label: 'Point to add' },
  { key: 'question', label: 'Question' },
  { key: 'suggestion', label: 'Suggestion' },
];
export const COMMENT_TYPE_KEYS = COMMENT_TYPES.map((t) => t.key);

// PRD §10.3
export const SLOT_STATUSES = {
  available: 'Available',
  booked: 'Booked',
  in_development: 'In Development',
  testing: 'Testing',
  completed: 'Completed',
  blocked: 'Blocked',
};

export const ROLES = ['user', 'team_member', 'admin', 'super_admin'];
export const ROLE_LABELS = { user: 'User', team_member: 'Team Member', admin: 'Admin', super_admin: 'Super Admin' };
const RANK = { user: 0, team_member: 1, admin: 2, super_admin: 3 };
export const atLeast = (user, role) => !!user && RANK[user.role] >= RANK[role];
export const isStaff = (user) => atLeast(user, 'team_member');

export const LIMITS = {
  title: 100,
  problem: 1500,
  expected: 500,
  comment: 1000,
  filesPerPds: 3,
  fileBytes: 5 * 1024 * 1024,
  openPdsPerUser: 3,
  commentsPerHour: 10,
  maxSizeWeeks: 12,
  calendarWeeks: 5, // current + next 4 (SL-03)
  cancelBookingHours: 48,
  autoCloseDays: 7,
};

export const DEFAULT_BLOCKED_WORDS = ['fuck', 'shit', 'bitch', 'bastard', 'chutiya', 'madarchod', 'bhenchod', 'randi', 'casino', 'viagra'];
