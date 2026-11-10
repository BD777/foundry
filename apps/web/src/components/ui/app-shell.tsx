import {
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { navHeadingClass, navItemClass } from "./nav-list";
import { ScrollArea } from "./scroll-area";
import { StatusIndicator, type StatusItem } from "./status-indicator";
import { ToastProvider, type ToastPlacement } from "./toast";
import { Tooltip } from "./tooltip";
import { FoundryThemeContext } from "./theme-context";

export type FoundryViewScrollMode = "contained" | "page";
export type FoundryThemeMode = "light" | "dark";

export interface FoundryShellProps extends HTMLAttributes<HTMLElement> {
  theme?: FoundryThemeMode;
  /**
   * How the current view scrolls. A contained view (a chat) fills the
   * viewport and scrolls its own parts, so on narrow screens the shell keeps
   * a fixed height instead of letting the page grow.
   */
  scrollMode?: FoundryViewScrollMode;
  /** Where transient feedback floats in this view (see ToastPlacement). */
  toastPlacement?: ToastPlacement;
}

/*
 * The shell's layout contract (audit-v3-layout-contract.mjs reads it from
 * here): the window never scrolls as a page; the shell fills the dynamic
 * viewport and each view decides how it scrolls. Under 861px the shell
 * stacks and the document scrolls a page view; a contained view (a chat), or
 * a page whose content is a full-height screen (viewFillClassName), holds
 * the viewport instead.
 */
const shellClassName =
  "fdy-foundry-shell group/shell flex h-dvh w-full overflow-hidden bg-paper max-[860px]:h-auto max-[860px]:min-h-dvh max-[860px]:flex-col max-[860px]:overflow-visible max-[860px]:data-[scroll-mode=contained]:h-dvh max-[860px]:data-[scroll-mode=contained]:min-h-0 max-[860px]:data-[scroll-mode=contained]:overflow-hidden max-[860px]:has-[.view-fill]:h-dvh max-[860px]:has-[.view-fill]:min-h-0 max-[860px]:has-[.view-fill]:overflow-hidden";

export function FoundryShell({
  className,
  theme = "light",
  scrollMode = "page",
  toastPlacement,
  children,
  ...props
}: FoundryShellProps) {
  return (
    <FoundryThemeContext.Provider value={theme}>
      <main
        className={cn(shellClassName, className)}
        data-scroll-mode={scrollMode}
        data-theme={theme}
        {...props}
      >
        <ToastProvider placement={toastPlacement}>{children}</ToastProvider>
      </main>
    </FoundryThemeContext.Provider>
  );
}

export function FoundryMain({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "fdy-main relative m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface shadow-sheet max-[860px]:m-0 max-[860px]:min-h-dvh max-[860px]:rounded-none max-[860px]:shadow-none max-[860px]:group-data-[scroll-mode=contained]/shell:min-h-0 max-[860px]:has-[.view-fill]:min-h-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Put on a page view's content that is itself a full-height screen (a
 * conversation inside an Issue): on narrow screens the shell then holds the
 * viewport like a contained view instead of letting the page grow. The view
 * is the page's scroller; reserving the scrollbar's space keeps centered
 * pages still when content grows past the viewport or shrinks back.
 */
export const viewFillClassName = "view-fill";

export interface FoundryViewProps extends HTMLAttributes<HTMLDivElement> {
  scrollMode: FoundryViewScrollMode;
}

export function FoundryView({
  className,
  scrollMode,
  ...props
}: FoundryViewProps) {
  return (
    <div
      className={cn(
        "fdy-view min-h-0 flex-1 overflow-hidden data-[scroll-mode=page]:overflow-x-hidden data-[scroll-mode=page]:overflow-y-auto data-[scroll-mode=page]:[scrollbar-gutter:stable] max-[860px]:data-[scroll-mode=page]:[scrollbar-gutter:auto] max-[860px]:has-[.view-fill]:flex max-[860px]:has-[.view-fill]:min-h-0",
        className,
      )}
      data-foundry-scroll-reset="true"
      data-foundry-view="true"
      data-scroll-mode={scrollMode}
      {...props}
    />
  );
}

export interface SidebarNavBadge {
  children: ReactNode;
  tone?: "brass" | "neutral";
}

export interface SidebarNavLiveCount {
  children: ReactNode;
}

export interface SidebarNavItem<T extends string> {
  badge?: SidebarNavBadge;
  icon: LucideIcon;
  id: T;
  label: string;
  liveCount?: SidebarNavLiveCount;
}

export interface SidebarNavSection<T extends string> {
  /** Stable identity, independent of the displayed language. */
  id: string;
  /** Context shown in navigation tooltips, including when collapsed. */
  scopeLabel?: string;
  /** A visible boundary before a new navigation scope, also when collapsed. */
  dividerBefore?: boolean;
  /** Controls for this section alone, before its links. */
  header?: ReactNode;
  items: Array<SidebarNavItem<T>>;
  label: string;
}

export interface FoundrySidebarProps<T extends string> {
  activeItemId?: T;
  /** The current page, shown beside the menu button on narrow screens. */
  pageTitle: string;
  brandName?: string;
  collapsed?: boolean;
  /** A control beside the theme button, such as the interface language. */
  languageControl?: ReactNode;
  navSections: Array<SidebarNavSection<T>>;
  onNavSelect: (id: T) => void;
  onThemeToggle?: () => void;
  onToggleCollapsed?: () => void;
  /**
   * Conditions of the whole app that hold until they clear (see
   * StatusIndicator), shown in place of the brand while any holds.
   */
  status?: readonly StatusItem[];
  theme?: FoundryThemeMode;
}

export function FoundrySidebar<T extends string>({
  activeItemId,
  pageTitle,
  brandName = "Foundry",
  collapsed = false,
  languageControl,
  navSections,
  onNavSelect,
  onThemeToggle,
  onToggleCollapsed,
  status,
  theme = "light",
}: FoundrySidebarProps<T>) {
  const { t } = useTranslation("shell");
  const [narrowMenuOpen, setNarrowMenuOpen] = useState(false);
  const narrowMenuId = useId();
  const selectNavItem = (id: T) => {
    setNarrowMenuOpen(false);
    onNavSelect(id);
  };
  const navigation = (select: (id: T) => void) => (
    <SidebarNav
      activeItemId={activeItemId}
      onSelect={select}
      sections={navSections}
    />
  );

  return (
    <>
      <aside
        className="fdy-sidebar group/sidebar flex min-h-0 w-[262px] flex-none flex-col bg-canvas transition-[width] duration-150 ease-out-strong min-[861px]:data-[collapsed=true]:w-16 max-[860px]:hidden"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <SidebarBrand
          collapsed={collapsed}
          name={brandName}
          languageControl={languageControl}
          onThemeToggle={onThemeToggle}
          onToggleCollapsed={onToggleCollapsed}
          status={status}
          theme={theme}
        />
        {navigation(onNavSelect)}
      </aside>

      <header className="fdy-mobile-bar sticky top-0 z-20 flex h-14 min-w-0 flex-none items-center gap-2 border-b border-line-strong bg-canvas px-3 min-[861px]:hidden">
        <Button
          aria-controls={narrowMenuId}
          aria-expanded={narrowMenuOpen}
          aria-haspopup="dialog"
          aria-label={t("sidebar.menu")}
          className="h-9 flex-none gap-1.5 rounded-md px-2.5 text-sm active:scale-100"
          onClick={() => setNarrowMenuOpen(true)}
          title={t("sidebar.menu")}
          variant="ghost"
        >
          <Menu size={18} />
          <span>{t("sidebar.menu")}</span>
        </Button>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-md leading-[1.3] font-semibold text-ink">
            {pageTitle}
          </span>
        </div>
        <SidebarInterfaceControls
          className="ml-0 flex-none rounded-none bg-transparent p-0 [--fdy-select-icon-size:32px]"
          languageControl={languageControl}
          onThemeToggle={onThemeToggle}
          theme={theme}
        />
      </header>

      <Dialog
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
        contentId={narrowMenuId}
        onClose={() => setNarrowMenuOpen(false)}
        open={narrowMenuOpen}
        side="left"
        title={brandName}
      >
        {navigation(selectNavItem)}
      </Dialog>
    </>
  );
}

const brandButtonClass =
  "fdy-sidebar-theme-button size-[26px] flex-none rounded-sm bg-transparent p-0 text-ink-faint shadow-none hover:bg-control-ghost-hover hover:text-ink";

export interface SidebarBrandProps {
  collapsed?: boolean;
  name: ReactNode;
  languageControl?: ReactNode;
  onThemeToggle?: () => void;
  onToggleCollapsed?: () => void;
  status?: readonly StatusItem[];
  theme?: FoundryThemeMode;
}

export function SidebarBrand({
  collapsed = false,
  name,
  languageControl,
  onThemeToggle,
  onToggleCollapsed,
  status = [],
  theme = "light",
}: SidebarBrandProps) {
  return (
    <div
      className={cn(
        "fdy-sidebar-brand relative flex min-w-0 flex-none items-center gap-2.5 px-[18px] pt-4 pb-3.5 rail:flex-col rail:px-0 rail:pt-3 rail:pb-2.5",
      )}
    >
      {status.length ? null : (
        <span className="fdy-sidebar-brand-icon inline-flex size-7 flex-none items-center justify-center overflow-hidden rounded-sm">
          <img
            alt=""
            className="block size-full object-contain"
            src={`${import.meta.env.BASE_URL}foundry-icon.png`}
          />
        </span>
      )}
      {/* One mount point, so its live region announces each change. The pill
          takes the brand name's place: no wrapper box of its own. */}
      <span className="fdy-sidebar-brand-status contents">
        <StatusIndicator iconOnly={collapsed} items={status} />
      </span>
      {status.length ? null : (
        <span className="fdy-sidebar-brand-copy grid min-w-0 rail:hidden">
          <strong className="min-w-0 truncate text-lg leading-[1.25] font-bold text-ink">
            {name}
          </strong>
        </span>
      )}
      <SidebarInterfaceControls
        className="fdy-sidebar-brand-actions ml-auto rail:ml-0 rail:flex-col rail:gap-0 rail:rounded-xl rail:bg-surface rail:p-1 rail:[--fdy-select-icon-size:32px]"
        collapsed={collapsed}
        languageControl={languageControl}
        onThemeToggle={onThemeToggle}
        onToggleCollapsed={onToggleCollapsed}
        theme={theme}
      />
    </div>
  );
}

interface SidebarInterfaceControlsProps {
  className?: string;
  collapsed?: boolean;
  languageControl?: ReactNode;
  onThemeToggle?: () => void;
  onToggleCollapsed?: () => void;
  theme: FoundryThemeMode;
}

function SidebarInterfaceControls({
  className,
  collapsed = false,
  languageControl,
  onThemeToggle,
  onToggleCollapsed,
  theme,
}: SidebarInterfaceControlsProps) {
  const { t } = useTranslation("shell");
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const themeLabel =
    theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode");
  const collapseLabel = collapsed ? t("sidebar.expand") : t("sidebar.collapse");

  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      role="group"
      aria-label={t("sidebar.interfaceControls")}
    >
      {languageControl}
      <Button
        aria-label={themeLabel}
        aria-pressed={theme === "dark"}
        className={cn(brandButtonClass, "rail:size-8 max-[860px]:size-8")}
        onClick={onThemeToggle}
        size="icon"
        title={themeLabel}
        variant="ghost"
      >
        <ThemeIcon size={15} />
      </Button>
      {onToggleCollapsed ? (
        <Button
          aria-label={collapseLabel}
          className={cn(
            brandButtonClass,
            "fdy-sidebar-collapse-button rail:size-8",
          )}
          onClick={onToggleCollapsed}
          size="icon"
          title={collapseLabel}
          variant="ghost"
        >
          <CollapseIcon size={15} />
        </Button>
      ) : null}
    </span>
  );
}

export interface SidebarNavProps<T extends string> {
  activeItemId?: T;
  onSelect: (id: T) => void;
  sections: Array<SidebarNavSection<T>>;
}

export function SidebarNav<T extends string>({
  activeItemId,
  onSelect,
  sections,
}: SidebarNavProps<T>) {
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  useEffect(() => {
    const revealActive = () => {
      const activeItem = activeItemId
        ? itemRefs.current.get(activeItemId)
        : null;
      activeItem?.scrollIntoView({ block: "nearest", inline: "center" });
    };
    revealActive();
    // Crossing the layout breakpoint reveals the current entry. A phone's
    // keyboard changes viewport height too; it must not pull the page back
    // to navigation while the person is editing its contents.
    const layout = window.matchMedia("(max-width: 860px)");
    layout.addEventListener("change", revealActive);
    return () => layout.removeEventListener("change", revealActive);
  }, [activeItemId]);

  return (
    <ScrollArea
      className="fdy-sidebar-nav-scroll min-h-0 w-full flex-1"
      direction="vertical"
      viewportClassName="overscroll-contain"
    >
      <nav
        className="fdy-sidebar-nav block min-w-0 px-3 pt-0.5 pb-3 rail:px-0"
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          if (
            ![
              "ArrowDown",
              "ArrowUp",
              "ArrowRight",
              "ArrowLeft",
              "Home",
              "End",
            ].includes(event.key)
          )
            return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          );
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" || event.key === "ArrowRight"
                      ? 1
                      : -1) +
                    buttons.length) %
                  buttons.length;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.dividerBefore ? (
              <div
                className="fdy-sidebar-scope-divider mt-3.5 border-t border-line-strong rail:mx-3 rail:my-4"
                aria-hidden="true"
              />
            ) : null}
            <section
              className="fdy-sidebar-nav-section group/section rail:[section+&]:mt-[18px]"
              data-section-id={section.id}
              aria-label={section.label}
            >
              <span
                className={cn(
                  navHeadingClass,
                  "fdy-sidebar-nav-heading group-first/section:pt-2 rail:hidden",
                )}
              >
                {section.label}
              </span>
              <div className="fdy-sidebar-nav-items">
                {section.header ? (
                  <div className="fdy-sidebar-section-header mb-1 min-w-0">
                    {section.header}
                  </div>
                ) : null}
                {section.items.map((item) => (
                  <SidebarNavButton
                    active={item.id === activeItemId}
                    item={item}
                    scopeLabel={section.scopeLabel ?? section.label}
                    key={item.id}
                    refCallback={(node) => {
                      if (node) {
                        itemRefs.current.set(item.id, node);
                      } else {
                        itemRefs.current.delete(item.id);
                      }
                    }}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </section>
          </Fragment>
        ))}
      </nav>
    </ScrollArea>
  );
}

const navLinkClass = cn(
  navItemClass,
  "fdy-sidebar-nav-link",
  "rail:mx-auto rail:mb-1 rail:min-h-10 rail:w-10 rail:justify-center rail:gap-0 rail:rounded-lg rail:p-0 rail:data-[state=idle]:hover:bg-control-ghost-hover",
);

interface SidebarNavButtonProps<T extends string> {
  active: boolean;
  item: SidebarNavItem<T>;
  scopeLabel: string;
  onSelect: (id: T) => void;
  refCallback?: (node: HTMLButtonElement | null) => void;
}

function SidebarNavButton<T extends string>({
  active,
  item,
  scopeLabel,
  onSelect,
  refCallback,
}: SidebarNavButtonProps<T>) {
  const { t } = useTranslation("shell");
  const Icon = item.icon;

  return (
    <Tooltip content={`${scopeLabel} · ${item.label}`}>
      <Button
        aria-current={active ? "page" : undefined}
        aria-label={t("sidebar.open", { label: item.label })}
        title={`${scopeLabel} · ${item.label}`}
        className={navLinkClass}
        data-nav-id={item.id}
        data-foundry-sidebar-nav-link="true"
        data-state={active ? "active" : "idle"}
        onClick={() => onSelect(item.id)}
        ref={refCallback}
        variant="nav"
      >
        <span
          className="fdy-sidebar-nav-icon inline-flex size-[18px] flex-none items-center justify-center [&_svg]:size-4 [&_svg]:flex-none [&_svg]:[stroke-width:1.8]"
          aria-hidden="true"
        >
          <Icon />
        </span>
        <span
          className={cn(
            "fdy-sidebar-nav-label min-w-0 flex-1 truncate text-left leading-[1.25] rail:hidden",
            active && "font-semibold",
          )}
        >
          {item.label}
        </span>
        {item.badge ? (
          <b
            className={cn(
              "flex-none h-[19px] min-w-[19px] rounded-full px-[5px] text-center font-mono text-2xs leading-[19px] font-semibold rail:hidden",
              item.badge.tone === "neutral"
                ? "bg-control-ghost-hover text-ink-muted"
                : "bg-accent-soft text-brand-dark",
            )}
            data-tone={item.badge.tone ?? "brass"}
          >
            {item.badge.children}
          </b>
        ) : null}
        {item.liveCount ? (
          <i className="inline-flex min-w-0 flex-none items-center gap-[5px] font-mono text-2xs leading-none font-semibold text-brand-dark not-italic rail:hidden">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-current" />
            {item.liveCount.children}
          </i>
        ) : null}
      </Button>
    </Tooltip>
  );
}
