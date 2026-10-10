import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout, type NavItem } from './components/Layout';
import { RequireSession } from './components/SignIn';
import { Spinner } from './components/ui';
import { SessionProvider } from './lib/auth';
import { AuthCallback } from './routes/AuthCallback';
import { Landing } from './routes/Landing';

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
    <Suspense fallback={<div className="p-6"><Spinner /></div>}>
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
const account = () => import('./routes/AccountPages');
const StaffProfile = page(account, 'StaffProfile');
const StaffHome = page(() => import('./routes/staff/HomePage'), 'StaffHome');
const help = () => import('./routes/HelpPages');
const HelpList = page(help, 'HelpList');
const ArticleView = page(help, 'ArticleView');
const BookPage = page(() => import('./routes/portal/BookPage'), 'BookPage');
const Knowledge = page(() => import('./routes/staff/KnowledgePages'), 'Knowledge');
const Todos = page(() => import('./routes/staff/TodoPages'), 'Todos');
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
  { to: '/staff/assistant', label: 'Assistant' },
  { to: '/staff/customers', label: 'Customers', can: ['read', 'customers'] },
  { to: '/staff/todos', label: 'To-dos', can: ['read', 'tasks'] },
  { to: '/staff/payments', label: 'Payments', can: ['create', 'payments'] },
  { to: '/staff/review', label: 'Review', can: ['update', 'appointments'] },
  { to: '/staff/access', label: 'Access', can: ['update', 'access'] },
  { to: '/staff/help', label: 'Help', can: ['read', 'knowledge'] },
  { to: '/staff/knowledge', label: 'Knowledge', can: ['update', 'knowledge'] },
  { to: '/staff/admin', label: 'Admin', can: ['update', 'settings'] },
];

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
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
            <Route path="tickets" element={<MyTickets />} />
            <Route path="tickets/:id" element={<TicketView back="/portal/tickets" />} />
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
                  <Layout title="JoyBot Staff" nav={STAFF_NAV} base="/staff" assistant={{ audience: 'employee', path: '/staff/assistant' }} />
                </RequireSession>
              </SessionProvider>
            }
          >
            <Route index element={<StaffHome />} />
            <Route path="assistant" element={<ChatPage audience="employee" />} />
            <Route path="customers" element={<Customers />} />
            <Route path="todos" element={<Todos />} />
            <Route path="help" element={<HelpList />} />
            <Route path="help/:slug" element={<ArticleView />} />
            <Route path="knowledge" element={<Knowledge />} />
            <Route path="customers/:id" element={<CustomerDetail />} />
            <Route path="payments" element={<Payments />} />
            <Route path="tickets/:id" element={<TicketView back="/staff/customers" />} />
            <Route path="admin" element={<Admin />} />
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
