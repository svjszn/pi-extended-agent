import { Layout, Navbar } from 'nextra-theme-docs';
import { Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import { PiMark } from '../components/pi-mark';
import 'nextra-theme-docs/style.css';
import './style.css';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const metadata = {
  metadataBase: new URL(`https://svjszn.github.io${basePath}/`),
  title: { default: 'Pi Extended Agent', template: '%s · Pi Extended Agent' },
  description: 'Learn how to install and use Pi Extended Agent: models, commands, planning, project memory, and configuration.',
  applicationName: 'Pi Extended Agent',
  icons: { icon: `${basePath}/favicon.svg` },
};

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head
        color={{ hue: 0, saturation: 0, lightness: { light: 10, dark: 100 } }}
        backgroundColor={{ light: '#fff', dark: '#000' }}
      />
      <body className="pi-docs">
        <Layout
          navbar={<Navbar
            logo={<span className="pi-brand"><PiMark size={22} /><span>Pi Extended Agent</span></span>}
            projectLink="https://github.com/svjszn/pi-extended-agent"
          />}
          footer={null}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/svjszn/pi-extended-agent/tree/main/docs"
          darkMode={false}
          copyPageButton={false}
          nextThemes={{ forcedTheme: 'dark', storageKey: 'pi-docs-monochrome-theme' }}
          sidebar={{ defaultMenuCollapseLevel: 1, autoCollapse: false, toggleButton: false }}
          toc={{ title: 'On this page', backToTop: 'Back to top' }}
          editLink={null}
          feedback={{ content: null }}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
