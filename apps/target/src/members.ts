export type Member = {
  id: string;
  name: string;
  savingsBalance: string;
};

const members = new Map<string, Member>([
  ["12345", { id: "12345", name: "Avery Chen", savingsBalance: "$4,281.36" }],
  ["67890", { id: "67890", name: "Jordan Rivera", savingsBalance: "$912.04" }]
]);

export function findMember(id: string): Member | undefined {
  return members.get(id);
}
