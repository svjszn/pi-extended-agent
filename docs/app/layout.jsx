import { Layout, Navbar } from 'nextra-theme-docs';
import { Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import { PiMark } from '../components/pi-mark';
import localFont from 'next/font/local';
import 'nextra-theme-docs/style.css';
import './style.css';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const inter = localFont({ src: '../assets/fonts/InterVariable.woff2', display: 'swap', weight: '100 900', variable: '--font-inter' });

export const metadata = {
  metadataBase: new URL(`https://svjszn.github.io${basePath}/`),
  title: { default: 'Pi Extended Agent', template: '%s · Pi Extended Agent' },
  description: 'Learn how to install and use Pi Extended Agent: models, commands, planning, project memory, and configuration.',
  applicationName: 'Pi Extended Agent',
  icons: { icon: { url: `${basePath}/favicon.svg?v=2`, type: 'image/svg+xml', sizes: 'any' } },
};

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head
        color={{ hue: 0, saturation: 0, lightness: { light: 10, dark: 100 } }}
        backgroundColor={{ light: '#fff', dark: '#000' }}
      />
      <body className={`${inter.variable} pi-docs`}>
        <Layout
          navbar={<Navbar
            logo={<span className="pi-brand"><PiMark size={23} /><span>Pi Extended Agent</span></span>}
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
