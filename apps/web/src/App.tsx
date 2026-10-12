import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout, type NavItem } from './components/Layout';
import { RequireSession } from './components/SignIn';
import { Spinner } from './components/ui';
import { LoadingMark } from './lib/loading';
import { SessionProvider } from './lib/auth';
import { AuthCallback } from './routes/AuthCallback';

/**
 * After a deploy, an open tab may ask for page chunks that no longer exist (new hashes): reload once
 * to pick up the new version instead of showing an error.
 */
function loadWithReload<M>(load: () => Promise<M>): Promise<M> {
  return load().then(
    (m) => {
      sessionStorage.removeItem('joybot.chunk-reload');
      return m;
    },
    (err) => {
      if (!sessionStorage.getItem('joybot.chunk-reload')) {
        sessionStorage.setItem('joybot.chunk-reload', '1');
        window.location.reload();
        return new Promise<M>(() => undefined);
      }
      throw err;
    },
  );
}

// Code-split: customers never download the staff console, and vice versa.
function page<M extends Record<string, ComponentType<any>>>(load: () => Promise<M>, name: keyof M) {
  const C = lazy(() => loadWithReload(load).then((m) => ({ default: m[name] as ComponentType<any> })));
  return (props: Record<string, unknown>) => (
    <Suspense
      fallback={
        <div className="p-6">
          <LoadingMark />
          <Spinner />
        </div>
      }
    >
      <C {...props} />
    </Suspense>
  );
}
const ChatPage = page(() => import('./components/chat/ChatPage'), 'ChatPage');
const portal = () => import('./routes/portal/PortalPages');
const staff = () => import('./routes/staff/StaffPages');
const MyAppointments = page(portal, 'MyAppointments');
const MyPayments = page(portal, 'MyPayments');
const Services = page(portal, 'Services');
const Locations = page(portal, 'Locations');
const profile = () => import('./routes/portal/ProfilePages');
const Profile = page(profile, 'Profile');
const InviteLanding = page(profile, 'InviteLanding');
const tickets = () => import('./routes/portal/TicketPages');
const MyTickets = page(tickets, 'MyTickets');
const TicketView = page(tickets, 'TicketView');
const Organization = page(tickets, 'Organization');
const StaffTickets = page(tickets, 'StaffTickets');
const account = () => import('./routes/AccountPages');
const StaffProfile = page(account, 'StaffProfile');
const StaffHome = page(() => import('./routes/staff/HomePage'), 'StaffHome');
const help = () => import('./routes/HelpPages');
const HelpList = page(help, 'HelpList');
const ArticleView = page(help, 'ArticleView');
const BookPage = page(() => import('./routes/portal/BookPage'), 'BookPage');
const Knowledge = page(() => import('./routes/staff/KnowledgePages'), 'Knowledge');
const Todos = page(() => import('./routes/staff/TodoPages'), 'Todos');
const CalendarPage = page(() => import('./routes/staff/CalendarPage'), 'CalendarPage');
const SchedulePage = page(() => import('./routes/staff/SchedulePage'), 'SchedulePage');
const ClaudeAccessPage = page(() => import('./routes/staff/McpTokens'), 'ClaudeAccessPage');
const site = () => import('./routes/site/SitePages');
const SiteLayout = page(site, 'SiteLayout');
const SitePageView = page(site, 'SitePageView');
const BookCallPage = page(() => import('./routes/site/BookCall'), 'BookCallPage');
const WebsitePage = page(() => import('./routes/staff/WebsitePages'), 'WebsitePage');
const EmailPage = page(() => import('./routes/staff/EmailPage'), 'EmailPage');
const SalesCallsPage = page(() => import('./routes/staff/SalesCalls'), 'SalesCallsPage');
const AuditLogPage = page(() => import('./routes/staff/AuditLog'), 'AuditLogPage');
const EmployeesPage = page(() => import('./routes/staff/EmployeesPage'), 'EmployeesPage');
const staffInvoices = () => import('./routes/staff/InvoicePages');
const Invoices = page(staffInvoices, 'Invoices');
const InvoicePage = page(staffInvoices, 'InvoicePage');
const portalInvoices = () => import('./routes/portal/InvoicePages');
const MyInvoices = page(portalInvoices, 'MyInvoices');
const MyInvoice = page(portalInvoices, 'MyInvoice');
const Customers = page(staff, 'Customers');
const CustomerDetail = page(staff, 'CustomerDetail');
const Payments = page(staff, 'Payments');
const Admin = page(staff, 'Admin');
const Review = page(() => import('./routes/staff/ReviewPages'), 'Review');
const Access = page(() => import('./routes/staff/AccessPages'), 'Access');

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, err) => count < 2 && !(err as { status?: number }).status, refetchOnWindowFocus: false } },
});

const PORTAL_NAV: NavItem[] = [
  { to: '/portal', label: 'Assistant', end: true },
  { to: '/portal/appointments', label: 'Appointments' },
  { to: '/portal/book', label: 'Book' },
  { to: '/portal/invoices', label: 'Invoices' },
  { to: '/portal/payments', label: 'Payments' },
  { to: '/portal/tickets', label: 'Support' },
  { to: '/portal/organization', label: 'Organization', role: 'org_admin' },
  { to: '/portal/services', label: 'Services' },
  { to: '/portal/locations', label: 'Locations' },
  { to: '/portal/help', label: 'Help' },
  { to: '/portal/profile', label: 'Profile' },
];

const STAFF_NAV: NavItem[] = [
  { to: '/staff', label: 'Home', end: true },
  { to: '/staff/calendar', label: 'Calendar', can: ['read', 'appointments'] },
  { to: '/staff/customers', label: 'Customers', can: ['read', 'customers'] },
  { to: '/staff/todos', label: 'To-dos', can: ['read', 'tasks'] },
  { to: '/staff/tickets', label: 'Tickets', can: ['read', 'tickets'] },
  {
    label: 'Billing',
    items: [
      { to: '/staff/payments', label: 'Payments', can: ['create', 'payments'] },
      { to: '/staff/invoices', label: 'Invoices', can: ['create', 'payments'] },
    ],
  },
  { to: '/staff/review', label: 'Review', can: ['update', 'appointments'] },
  { to: '/staff/help', label: 'Knowledge', can: ['read', 'knowledge'] },
  {
    label: 'Marketing',
    items: [
      { to: '/staff/website', label: 'Website', can: ['read', 'website'] },
      { to: '/staff/sales-calls', label: 'Sales calls', can: ['read', 'website'] },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/staff/employees', label: 'Employees', can: ['read', 'users'] },
      { to: '/staff/access', label: 'Access', can: ['update', 'access'] },
      { to: '/staff/knowledge', label: 'Answers', can: ['update', 'knowledge'] },
      { to: '/staff/admin', label: 'Settings', can: ['update', 'settings'] },
      { to: '/staff/email', label: 'Email', can: ['update', 'settings'] },
      { to: '/staff/claude', label: 'Claude access', role: 'admin' },
      { to: '/staff/audit', label: 'Audit log', can: ['read', 'audit'] },
    ],
  },
];

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* The public website: "/" is the home page, "/:slug" any other published page. */}
          <Route path="/" element={<SiteLayout />}>
            <Route index element={<SitePageView home />} />
            <Route path="book-a-call" element={<BookCallPage />} />
            <Route path=":slug" element={<SitePageView />} />
          </Route>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route
            path="/portal/invite"
            element={
              <SessionProvider audience="customer">
                <InviteLanding />
              </SessionProvider>
            }
          />
          <Route
            path="/portal"
            element={
              <SessionProvider audience="customer">
                <RequireSession>
                  <Layout title="JoyBot" nav={PORTAL_NAV} base="/portal" assistant={{ audience: 'customer', path: '/portal' }} />
                </RequireSession>
              </SessionProvider>
            }
          >
            <Route index element={<ChatPage audience="customer" />} />
            <Route path="appointments" element={<MyAppointments />} />
            <Route path="book" element={<BookPage />} />
            <Route path="help" element={<HelpList />} />
            <Route path="help/:slug" element={<ArticleView />} />
            <Route path="payments" element={<MyPayments />} />
            <Route path="invoices" element={<MyInvoices />} />
            <Route path="invoices/:id" element={<MyInvoice />} />
            <Route path="tickets" element={<MyTickets />} />
            <Route path="tickets/:id" element={<TicketView />} />
            <Route path="organization" element={<Organization />} />
            <Route path="services" element={<Services />} />
            <Route path="locations" element={<Locations />} />
            <Route path="profile" element={<Profile />} />
            <Route path="preferences" element={<Navigate to="/portal/profile" replace />} />
          </Route>
          <Route
            path="/staff"
            element={
              <SessionProvider audience="employee">
                <RequireSession>
                  <Layout title="JoyBot" nav={STAFF_NAV} base="/staff" assistant={{ audience: 'employee', path: '/staff/assistant' }} />
                </RequireSession>
              </SessionProvider>
            }
          >
            <Route index element={<StaffHome />} />
            <Route path="assistant" element={<ChatPage audience="employee" />} />
            <Route path="customers" element={<Customers />} />
            <Route path="todos" element={<Todos />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="claude" element={<ClaudeAccessPage />} />
            <Route path="invoices" element={<Invoices />} />
            <Route path="invoices/:id" element={<InvoicePage />} />
            <Route path="help" element={<HelpList />} />
            <Route path="help/:slug" element={<ArticleView />} />
            <Route path="knowledge" element={<Knowledge />} />
            <Route path="customers/:id" element={<CustomerDetail />} />
            <Route path="payments" element={<Payments />} />
            <Route path="tickets" element={<StaffTickets />} />
            <Route path="tickets/:id" element={<TicketView staff />} />
            <Route path="admin" element={<Admin />} />
            <Route path="employees" element={<EmployeesPage />} />
            <Route path="audit" element={<AuditLogPage />} />
            <Route path="website" element={<WebsitePage />} />
            <Route path="sales-calls" element={<SalesCallsPage />} />
            <Route path="email" element={<EmailPage />} />
            <Route path="review" element={<Review />} />
            <Route path="access" element={<Access />} />
            <Route path="profile" element={<StaffProfile />} />
            <Route path="preferences" element={<Navigate to="/staff/profile" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
