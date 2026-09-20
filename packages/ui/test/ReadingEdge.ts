/**
 * Measures a READING EDGE from the rendered styles: how far an element's content starts from the
 * inline-start side of a root, at a given viewport width.
 *
 * jsdom lays nothing out, so a bounding rect reads zero. What it does carry is the real cascade:
 * emotion injects every rule the components emit, and inline styles sit on the elements. The edge
 * of a block-flow chain is the sum of each box's margin, border and padding on the inline-start
 * side, from the root's first descendant down to the element itself — which is what this reads,
 * evaluating `min-width` media blocks against the viewport width it was given.
 *
 * It refuses what it cannot resolve (a percentage, a calc, an `auto` margin that would centre a
 * capped box) instead of reading it as zero, so a green result is a measured one.
 */
export class ReadingEdge {
  constructor(private readonly viewportWidth: number) {}

  /** The inline-start edge of `element`'s content box, measured from `root`'s content box. */
  of(element: Element, root: Element): number {
    if (!root.contains(element) || element === root) {
      throw new Error('ReadingEdge: the element must be a descendant of the root');
    }

    let edge = 0;
    for (let box: Element | null = element; box && box !== root; box = box.parentElement) {
      edge += this.insetOf(box);
    }

    return edge;
  }

  private insetOf(box: Element): number {
    return this.marginOf(box) + this.borderOf(box) + this.pixels(box, 'padding-left');
  }

  private borderOf(box: Element): number {
    const style = this.declared(box, 'border-left-style');
    return style === '' || style === 'none' ? 0 : this.pixels(box, 'border-left-width');
  }

  private marginOf(box: Element): number {
    const declared = this.declared(box, 'margin-left');
    if (declared !== 'auto') {
      return this.pixels(box, 'margin-left');
    }

    // An auto margin centres a box only when the box is narrower than its container: a cap at or
    // above the viewport can never be, so the margin resolves to zero.
    const cap = this.declared(box, 'max-width');
    const capPx = cap.endsWith('px') ? parseFloat(cap) : undefined;
    if (capPx === undefined || capPx < this.viewportWidth) {
      throw new Error(`ReadingEdge: an auto margin on a box capped at '${cap}' cannot be resolved without layout`);
    }

    return 0;
  }

  private pixels(box: Element, property: string): number {
    const declared = this.declared(box, property);
    if (declared === '' || declared === '0') {
      return 0;
    }

    if (!/^-?\d+(\.\d+)?px$/.test(declared)) {
      throw new Error(`ReadingEdge: cannot resolve ${property}: '${declared}' without layout`);
    }

    return parseFloat(declared);
  }

  /**
   * The cascaded value of one longhand: every matching rule in source order (emotion's selectors
   * are single generated classes, so source order IS the cascade), then the inline style. A
   * scratch declaration expands the shorthands (`padding: 0 16px`, `border: 1px solid`).
   */
  private declared(box: Element, property: string): string {
    const scratch = document.createElement('div').style;
    for (const rule of this.rulesFor(box)) {
      for (const name of Array.from(rule.style)) {
        scratch.setProperty(name, rule.style.getPropertyValue(name));
      }
    }

    const inline = (box as HTMLElement).style;
    for (const name of Array.from(inline)) {
      scratch.setProperty(name, inline.getPropertyValue(name));
    }

    return scratch.getPropertyValue(property).trim();
  }

  private rulesFor(box: Element): CSSStyleRule[] {
    const matching: CSSStyleRule[] = [];
    const collect = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        const media = (rule as CSSMediaRule).media;
        if (media) {
          if (this.mediaApplies(media.mediaText)) {
            collect((rule as CSSMediaRule).cssRules);
          }
          continue;
        }

        const styleRule = rule as CSSStyleRule;
        if (styleRule.selectorText && this.matches(box, styleRule.selectorText)) {
          matching.push(styleRule);
        }
      }
    };
    for (const styleElement of Array.from(document.querySelectorAll('style'))) {
      if (styleElement.sheet) {
        collect(styleElement.sheet.cssRules);
      }
    }

    return matching;
  }

  /** Width queries are evaluated against the viewport; any other media feature does not apply. */
  private mediaApplies(mediaText: string): boolean {
    const minWidth = /^\(min-width:\s*(\d+(\.\d+)?)px\)$/.exec(mediaText.trim());
    if (minWidth) {
      return this.viewportWidth >= parseFloat(minWidth[1]);
    }

    const maxWidth = /^\(max-width:\s*(\d+(\.\d+)?)px\)$/.exec(mediaText.trim());
    if (maxWidth) {
      return this.viewportWidth <= parseFloat(maxWidth[1]);
    }

    return false;
  }

  private matches(box: Element, selectorText: string): boolean {
    try {
      return box.matches(selectorText);
    } catch {
      // A selector jsdom cannot parse (a vendor pseudo-element) targets no box this reads.
      return false;
    }
  }
}
