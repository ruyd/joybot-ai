# UI

Design screens for the staff console and the customer portal, with sample data for a software dev studio (Lumen Studio). They show the intended look. The app ships the shared parts (theme, side menu, portal tabs and components); some page layouts shown here are still to come.

- Accent: green `#0B7A62` with flat fills. The side menu is dark ink in both themes. Text is Inter.
- Staff console: one side menu grouped into Workspace, Money, Grow and Settings, with a slim top bar (Ask JoyBot, theme, team).
- Customer portal: a top bar with the business name and underlined tabs.

Images live in [docs/screens](docs/screens), rendered at 1440 px wide.

## Staff console

### Dashboard
Key numbers, today's appointments by status, to-dos, quick actions, Ask JoyBot and website visits.

![Dashboard](docs/screens/dashboard.png)

### Customer profile
One activity timeline (appointments, payments, tickets, chats), contact details with masked contacts, internal notes, and who can access the customer.

![Customer profile](docs/screens/customer-profile.png)

### Tickets inbox
Ticket list, conversation with the JoyBot handoff and a suggested reply that names its sources, and the customer's details alongside.

![Tickets inbox](docs/screens/tickets-inbox.png)

### Calendar
Day view with a column per staff member, working hours, the current time, and requests that still need staff.

![Calendar](docs/screens/calendar.png)

### Invoices
Totals by status, bank transfers waiting to be matched, and the invoice list with status tabs.

![Invoices](docs/screens/invoices.png)

### Payments
Take a payment (card on the POS terminal, bank transfer or cash) and apply it to an invoice, match pending bank transfers, and see recent payments.

![Payments](docs/screens/payments.png)

### Sales calls
Website visitors who booked a call, the selected call's details, the Meet link, their question, notes and follow-up emails.

![Sales calls](docs/screens/sales-calls.png)

### Knowledge
"What would the assistant find?" tester, saved answers, and the answer editor with example questions and buttons.

![Knowledge](docs/screens/knowledge.png)

### Settings › AI
Assistant on or off for customers and employees, the answer mode (Model, Auto, or search only), the chat model and a test.

![Settings, AI](docs/screens/settings-ai.png)

## Customer portal

### Assistant
Answers with sources and buttons from saved answers, suggested questions, and the next appointment, balance due and open ticket.

![Portal assistant](docs/screens/portal-assistant.png)

### Appointments
The next appointment with Reschedule and Cancel, upcoming appointments including a request still waiting for confirmation, and past visits with Book again.

![Portal appointments](docs/screens/portal-appointments.png)

### Book
Service, location (including remote), day and time, with a live summary and Request this time.

![Portal booking](docs/screens/portal-book.png)

### Pay an invoice
The invoice, and payment by card (Stripe checkout) or bank transfer with the reference to use.

![Portal invoice payment](docs/screens/portal-invoice.png)
