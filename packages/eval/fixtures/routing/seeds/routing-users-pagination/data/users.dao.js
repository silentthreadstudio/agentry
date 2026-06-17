// Data-access layer: the source of user rows. Returns ALL users — no limit/offset, no count query.

const USERS = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
  { id: 3, name: "Linus" },
  { id: 4, name: "Margaret" },
  { id: 5, name: "Dennis" },
];

export async function fetchAllUsers() {
  return USERS.slice();
}
