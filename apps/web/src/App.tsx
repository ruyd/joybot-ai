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
const Profile = page(portal, 'Profile');
const tickets = () => import('./routes/portal/TicketPages');
const MyTickets = page(tickets, 'MyTickets');
const TicketView = page(tickets, 'TicketView');
const Organization = page(tickets, 'Organization');
const Customers = page(staff, 'Customers');
const CustomerDetail = page(staff, 'CustomerDetail');
const Payments = page(staff, 'Payments');
const Admin = page(staff, 'Admin');

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, err) => count < 2 && !(err as { status?: number }).status, refetchOnWindowFocus: false } },
});

const PORTAL_NAV: NavItem[] = [
  { to: '/portal', label: 'Assistant', end: true },
  { to: '/portal/appointments', label: 'Appointments' },
  { to: '/portal/payments', label: 'Payments' },
  { to: '/portal/tickets', label: 'Support' },
  { to: '/portal/organization', label: 'Organization', role: 'org_admin' },
  { to: '/portal/services', label: 'Services' },
  { to: '/portal/locations', label: 'Locations' },
  { to: '/portal/profile', label: 'Profile' },
];

const STAFF_NAV: NavItem[] = [
  { to: '/staff', label: 'Assistant', end: true },
  { to: '/staff/customers', label: 'Customers', can: ['read', 'customers'] },
  { to: '/staff/payments', label: 'Payments', can: ['create', 'payments'] },
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
            path="/portal"
            element={
              <SessionProvider audience="customer">
                <RequireSession>
                  <Layout title="JoyBot" nav={PORTAL_NAV} />
                </RequireSession>
              </SessionProvider>
            }
          >
            <Route index element={<ChatPage audience="customer" />} />
            <Route path="appointments" element={<MyAppointments />} />
            <Route path="payments" element={<MyPayments />} />
            <Route path="tickets" element={<MyTickets />} />
            <Route path="tickets/:id" element={<TicketView back="/portal/tickets" />} />
            <Route path="organization" element={<Organization />} />
            <Route path="services" element={<Services />} />
            <Route path="locations" element={<Locations />} />
            <Route path="profile" element={<Profile />} />
          </Route>
          <Route
            path="/staff"
            element={
              <SessionProvider audience="employee">
                <RequireSession>
                  <Layout title="JoyBot Staff" nav={STAFF_NAV} />
                </RequireSession>
              </SessionProvider>
            }
          >
            <Route index element={<ChatPage audience="employee" />} />
            <Route path="customers" element={<Customers />} />
            <Route path="customers/:id" element={<CustomerDetail />} />
            <Route path="payments" element={<Payments />} />
            <Route path="tickets/:id" element={<TicketView back="/staff/customers" />} />
            <Route path="admin" element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
