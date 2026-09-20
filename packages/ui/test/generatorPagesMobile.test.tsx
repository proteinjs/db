/**
 * @jest-environment jsdom
 *
 * The generator pages' phone layout. They are form pages, so on the phone they take the same
 * full-bleed face the record form page has: no card, no page gutters, no page top margin — the
 * form spans the shell's page column and reads at the pane's one 16px edge. Inside a card inside
 * a guttered column the same form read at 32, a second edge beside every other page's 16.
 * Desktop keeps the house FormPage card.
 *
 * The edge is a rendered OUTCOME: `ReadingEdge` measures it from the emitted styles on a 390-wide
 * container, title and fields alike.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { Page } from '@proteinjs/ui';
import { hashGeneratorPage } from '../src/pages/HashGeneratorPage';
import { uuidGeneratorPage } from '../src/pages/UuidGeneratorPage';
import { ReadingEdge } from './ReadingEdge';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let phoneMode = true;
beforeAll(() => {
  (window as any).matchMedia = (query: string) => ({
    matches: phoneMode,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
});

const PHONE_WIDTH = 390;
const READING_EDGE = 16;

/** Emotion under jest injects rules via CSSOM; read the actual styles the classes apply. */
const cssFor = (el: Element): string => {
  const classes = Array.from(el.classList).filter((cls) => cls.startsWith('css-'));
  const out: string[] = [];
  Array.from(document.querySelectorAll('style')).forEach((styleEl) => {
    const rules = styleEl.sheet?.cssRules ?? ([] as unknown as CSSRuleList);
    Array.from(rules).forEach((rule) => {
      if (classes.some((cls) => rule.cssText.includes(`.${cls}`))) {
        out.push(rule.cssText);
      }
    });
  });
  return out.join('\n');
};

const generatorPages: { page: Page; title: string; fieldCount: number }[] = [
  { page: hashGeneratorPage, title: 'Hash Generator', fieldCount: 2 },
  { page: uuidGeneratorPage, title: 'Uuid Generator', fieldCount: 1 },
];

describe.each(generatorPages)('$title page phone layout', ({ page, title, fieldCount }) => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.width = `${PHONE_WIDTH}px`;
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const mount = async () => {
    const Component = page.component as React.ComponentType<any>;
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Component urlParams={{}} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const titleElement = () =>
    Array.from(container.querySelectorAll<HTMLElement>('h6')).find((element) => element.textContent === title)!;

  it('phone: the title and every field read at 16 on a 390-wide container', async () => {
    phoneMode = true;
    await mount();
    const edge = new ReadingEdge(PHONE_WIDTH);

    expect(edge.of(titleElement(), container)).toBe(READING_EDGE);
    const fields = Array.from(container.querySelectorAll('[data-form-field-row] .MuiFormControl-root'));
    expect(fields.length).toBe(fieldCount);
    fields.forEach((field) => expect(edge.of(field, container)).toBe(READING_EDGE));
  });

  it('phone: full-bleed — no card, no page top margin; the page column scrolls the form itself', async () => {
    phoneMode = true;
    await mount();

    expect(container.querySelector('.MuiPaper-root')).toBeNull();
    const host = container.firstElementChild as HTMLElement;
    expect(host.hasAttribute('data-phone-fullbleed')).toBe(true);
    const hostCss = cssFor(host);
    expect(hostCss).toContain('flex-grow: 1');
    expect(hostCss).toContain('min-height: 0');
    expect(hostCss).toContain('overflow: auto');
    expect(hostCss).not.toContain('margin-top');
    expect(container.textContent).toContain('Generate');
  });

  it('desktop: the FormPage card stays unchanged', async () => {
    phoneMode = false;
    await mount();

    expect(container.querySelector('.MuiPaper-root')).toBeTruthy();
    expect(container.querySelector('[data-phone-fullbleed]')).toBeNull();
    expect(titleElement()).toBeTruthy();
  });
});
