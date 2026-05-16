---
name: Technical Precision
colors:
  surface: '#10131a'
  surface-dim: '#10131a'
  surface-bright: '#363941'
  surface-container-lowest: '#0b0e15'
  surface-container-low: '#191b23'
  surface-container: '#1d2027'
  surface-container-high: '#272a31'
  surface-container-highest: '#32353c'
  on-surface: '#e1e2ec'
  on-surface-variant: '#c2c6d6'
  inverse-surface: '#e1e2ec'
  inverse-on-surface: '#2e3038'
  outline: '#8c909f'
  outline-variant: '#424754'
  surface-tint: '#adc6ff'
  primary: '#adc6ff'
  on-primary: '#002e6a'
  primary-container: '#4d8eff'
  on-primary-container: '#00285d'
  inverse-primary: '#005ac2'
  secondary: '#b9c8de'
  on-secondary: '#233143'
  secondary-container: '#39485a'
  on-secondary-container: '#a7b6cc'
  tertiary: '#ffb786'
  on-tertiary: '#502400'
  tertiary-container: '#df7412'
  on-tertiary-container: '#461f00'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a42'
  on-primary-fixed-variant: '#004395'
  secondary-fixed: '#d4e4fa'
  secondary-fixed-dim: '#b9c8de'
  on-secondary-fixed: '#0d1c2d'
  on-secondary-fixed-variant: '#39485a'
  tertiary-fixed: '#ffdcc6'
  tertiary-fixed-dim: '#ffb786'
  on-tertiary-fixed: '#311400'
  on-tertiary-fixed-variant: '#723600'
  background: '#10131a'
  on-background: '#e1e2ec'
  surface-variant: '#32353c'
typography:
  h1:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  h2:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-caps:
    fontFamily: Space Grotesk
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  mono-ui:
    fontFamily: monospace
    fontSize: 13px
    fontWeight: '450'
    lineHeight: 20px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  gutter: 16px
  sidebar_width: 260px
---

## Brand & Style
The design system is engineered for high-velocity issue management, prioritizing information density and technical clarity. The brand personality is **reliable, efficient, and AI-native**, evoking the feeling of a sophisticated command center rather than a standard project management tool.

The visual style is **Corporate / Modern** with a strong leaning toward a **High-Density Developer Tool** aesthetic. It employs a rigorous structural grid, subtle monochromatic depth, and precise 1px borders to organize complex data without overwhelming the user. The interface should feel "utilitarian-premium," where every pixel serves a functional purpose, minimizing cognitive load for developers managing complex workflows.

## Colors
The palette is anchored in a **Dark Mode** first approach to reduce eye strain during deep work. The foundation uses **Slate and Charcoal** tones to create a sophisticated, low-distraction environment.

- **Canvas & Surfaces:** The deepest slate (#020617) is used for the main canvas, with progressively lighter slate tones for sidebars and cards to create hierarchy.
- **Accents:** Semantic colors are used strictly for status and intent. Success Green, Warning Amber, Info Blue, and Error Red provide immediate visual feedback on build statuses, issue priority, and system logs.
- **Borders:** All UI boundaries use a consistent 1px slate border (#334155) to define structure without high-contrast interference.

## Typography
The system utilizes a dual-font approach to distinguish between UI orchestration and technical data.

- **UI Interface:** **Inter** is the primary driver for all navigation, headings, and body text. It is chosen for its exceptional legibility at small sizes and high-density layouts.
- **Technical Data:** A **Monospace** font (JetBrains Mono or Fira Code) is mandatory for issue IDs (e.g., `CZ-102`), code snippets, terminal logs, and SHA hashes.
- **Metadata:** **Space Grotesk** is used sparingly for small caps labels to provide a slight "technical-futuristic" edge to the AI-native components like "Skills" and "Runs."

## Layout & Spacing
The layout follows a **Fluid Grid** model with fixed-width sidebars. The density is high, utilizing a 4px baseline shift to ensure elements are tightly packed but logically separated.

- **Grid:** A 12-column grid is used for main content areas, while specialized "DevViews" (like log streams) may use a single-column fluid layout.
- **Sidebars:** Primary navigation is fixed at 260px. A secondary right-hand "Context" sidebar is used for issue metadata, fixed at 320px.
- **Margins:** Standard page margins are 24px, but internal component spacing (padding within cards) is reduced to 12px or 16px to maximize information visibility.

## Elevation & Depth
In this design system, depth is communicated through **Tonal Layers** rather than heavy shadows.

- **Level 0 (Canvas):** The base background (#020617).
- **Level 1 (Sidebars/Cards):** Slightly elevated surface (#0f172a) with a 1px border.
- **Level 2 (Modals/Popovers):** The most elevated surface (#1e293b). These are the only elements allowed to have an **Ambient Shadow**: a very subtle, diffused dark shadow (0px 8px 24px rgba(0,0,0,0.5)) to separate them from the background.
- **Active State:** Hovered or focused items use a subtle "Ghost Glow"—a slight increase in border brightness rather than a change in surface color.

## Shapes
The shape language is disciplined and geometric.

- **Standard Radius:** A 6px (soft) radius is applied to all primary containers (cards, input fields, buttons).
- **Inner Radius:** When elements are nested (e.g., a button inside a padded card), the inner radius should be 4px to maintain visual concentricity.
- **Pills:** Only used for "Status Badges" and "Tags" to distinguish them from actionable buttons or interactive inputs.

## Components
- **Buttons:** Primary buttons use a solid Slate-100/White text on a Primary Blue background. Secondary buttons use a "Ghost" style: 1px border with no background until hover.
- **Issue Cards:** High-density rows with a monospace Issue ID, a title in Inter Medium, and a right-aligned "Assignee" avatar.
- **Skills & Runs (Specialty):**
    - **Skills:** Represented by a "Spark" icon and a distinctive cyan-tinted border to indicate AI-assisted capabilities.
    - **Runs:** Represented by a "Terminal" icon, using a progress-bar style indicator to show live execution status.
- **Input Fields:** Dark backgrounds (#020617) with 1px slate borders. Focus state uses a 1px primary blue border with a subtle outer glow.
- **Chips/Badges:** Small, 11px font size, semi-transparent background tints of the semantic colors (e.g., Success Green at 10% opacity with 100% opacity text).
- **Log Viewer:** A dedicated component using the monospace font on a pure black background, with syntax highlighting for common log levels (INFO, WARN, ERROR).
