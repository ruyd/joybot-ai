// Local stand-in for the Freshdesk API v2 (plan.md §4.5) with tickets for the sample customers.
// Run: node tools/fake-freshdesk.mjs   then set in .env:
//   FRESHDESK_BASE_URL=http://localhost:4010   FRESHDESK_API_KEY=local
// and a Freshdesk domain in Admin → Settings (any value, e.g. demo.freshdesk.com).
import http from 'node:http';

const port = Number(process.env.PORT ?? 4010);
const contacts = {
  'email:maria@example.com': 101,
  'email:john@acme.example': 102,
  'email:jane@acme.example': 103,
  'phone:+13105550106': 106,
};
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const t = (id, requester_id, subject, status, ageDays, description) => ({
  id, requester_id, subject, status, priority: 2, created_at: day(ageDays + 2), updated_at: day(ageDays), description_text: description,
});
const tickets = [
  t(5001, 101, 'Refund for cancelled haircut', 2, 1, 'I cancelled my appointment on time but was still charged.'),
  t(5002, 101, 'Change my appointment time', 4, 9, 'Can I move my next appointment to the afternoon?'),
  t(5003, 102, 'Acme invoice question', 3, 2, 'Our accounting team needs an itemized invoice for September.'),
  t(5004, 103, 'Parking at the Midtown office', 5, 20, 'Is there parking near the Midtown location?'),
  t(5006, 106, 'Deep clean availability', 2, 0, 'Do you have deep clean slots next week?'),
];
const conversations = {
  5001: [
    { id: 1, body_text: 'Thanks for reaching out — we are checking your payment.', private: false, incoming: false, user_id: 1, created_at: day(1) },
    { id: 2, body_text: 'Internal: refund approved, waiting on POS reversal.', private: true, incoming: false, user_id: 1, created_at: day(0.5) },
  ],
};

http
  .createServer((req, res) => {
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v2/contacts') {
      const [field, value] = [...url.searchParams.entries()][0] ?? [];
      const id = contacts[`${field === 'mobile' ? 'phone' : field}:${value}`];
      return json(200, id && field !== 'mobile' ? [{ id }] : []);
    }
    if (url.pathname === '/api/v2/tickets') {
      const r = url.searchParams.get('requester_id');
      return json(200, r ? tickets.filter((x) => String(x.requester_id) === r) : tickets.slice(0, 1));
    }
    let m = /^\/api\/v2\/tickets\/(\d+)\/conversations$/.exec(url.pathname);
    if (m) return json(200, conversations[m[1]] ?? []);
    m = /^\/api\/v2\/tickets\/(\d+)$/.exec(url.pathname);
    if (m) {
      const found = tickets.find((x) => x.id === Number(m[1]));
      return found ? json(200, found) : json(404, {});
    }
    json(404, {});
  })
  .listen(port, () => console.log(`fake Freshdesk on http://localhost:${port}`));
