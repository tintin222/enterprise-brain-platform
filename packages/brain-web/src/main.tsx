// The brain's pages (docs/brain/01-phase0-plan.md section 10): search, containers, entities with versions and
// backlinks. Every string lives in i18n/en.json (NFR-10).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App } from './App.tsx';
import en from './i18n/en.json';
import { ContainerPage } from './pages/ContainerPage.tsx';
import { ContainersPage } from './pages/ContainersPage.tsx';
import { EntityPage } from './pages/EntityPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'containers', element: <ContainersPage /> },
      { path: 'containers/:id', element: <ContainerPage /> },
      { path: 'entities/:id', element: <EntityPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IntlProvider locale="en" messages={en}>
      <RouterProvider router={router} />
    </IntlProvider>
  </StrictMode>,
);
