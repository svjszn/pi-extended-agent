import { useMDXComponents as getThemeComponents } from 'nextra-theme-docs';
import { CardGrid, DocCard, DocsIntro } from './components/docs-ui';

const themeComponents = getThemeComponents();

export function useMDXComponents(components) {
  return { ...themeComponents, CardGrid, DocCard, DocsIntro, ...components };
}
