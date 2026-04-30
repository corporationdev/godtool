import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export type AccountUser = {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
};

export type AccountOrganization = {
  readonly id: string;
  readonly name: string;
};

export type AccountAuthState =
  | { readonly status: "loading" }
  | { readonly status: "unauthenticated" }
  | {
      readonly status: "authenticated";
      readonly user: AccountUser;
      readonly organization: AccountOrganization | null;
    };

type AccountMenuProps = {
  readonly auth: AccountAuthState;
  readonly organizations?: readonly AccountOrganization[];
  readonly activeOrganizationId?: string | null;
  readonly organizationsLoading?: boolean;
  readonly organizationsError?: boolean;
  readonly onSignIn?: () => void;
  readonly onSignOut?: () => void | Promise<void>;
  readonly onSwitchOrganization?: (organizationId: string) => void | Promise<void>;
  readonly onCreateOrganization?: () => void;
  readonly settingsLink?: ReactNode;
};

const initialsFor = (name: string | null, email: string): string => {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  return email[0]?.toUpperCase() ?? "?";
};

function AccountAvatar(props: {
  readonly url: string | null;
  readonly name: string | null;
  readonly email: string;
  readonly size?: "sm" | "md";
}) {
  const size = props.size === "md" ? "size-8" : "size-7";
  const text = props.size === "md" ? "text-sm" : "text-xs";
  if (props.url) {
    return <img src={props.url} alt="" className={`${size} shrink-0 rounded-full`} />;
  }
  return (
    <div
      className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-primary/10 ${text} font-semibold text-primary`}
    >
      {initialsFor(props.name, props.email)}
    </div>
  );
}

function CheckMark() {
  return <CheckIcon aria-hidden className="ml-auto size-3 text-muted-foreground" />;
}

export function AccountMenu(props: AccountMenuProps) {
  if (props.auth.status === "loading") {
    return (
      <Button
        type="button"
        variant="ghost"
        disabled
        className="flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-1 py-1 text-left group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
      >
        <div className="size-7 shrink-0 rounded-full bg-muted" />
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="mt-1.5 h-3 w-16 rounded bg-muted" />
        </div>
      </Button>
    );
  }

  if (props.auth.status === "unauthenticated") {
    return (
      <Button
        type="button"
        variant="outline"
        disabled={!props.onSignIn}
        onClick={props.onSignIn}
        className="h-9 w-full justify-center rounded-md bg-background/50 text-sm group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:text-[0]"
      >
        Sign in
      </Button>
    );
  }

  const { user, organization } = props.auth;
  const organizations = props.organizations ?? [];
  const canSwitchOrganizations = Boolean(props.onSwitchOrganization);
  const showOrganizationPicker =
    canSwitchOrganizations || organization !== null || props.onCreateOrganization !== undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-1 py-1 text-left hover:bg-sidebar-active/60 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
        >
          <AccountAvatar url={user.avatarUrl} name={user.name} email={user.email} />
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-xs font-medium text-foreground">
              {user.name ?? user.email}
            </p>
            {organization && (
              <p className="truncate text-xs text-muted-foreground">{organization.name}</p>
            )}
          </div>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            className="size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
          >
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Organization
        </DropdownMenuLabel>
        {showOrganizationPicker ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="text-xs">
              <span className="min-w-0 flex-1 truncate">
                {organization?.name ?? "No organization"}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {props.organizationsLoading ? (
                <DropdownMenuItem disabled>Loading...</DropdownMenuItem>
              ) : props.organizationsError ? (
                <DropdownMenuItem disabled>Failed to load organizations</DropdownMenuItem>
              ) : organizations.length === 0 && organization ? (
                <DropdownMenuItem className="text-xs" disabled={!canSwitchOrganizations}>
                  <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  <CheckMark />
                </DropdownMenuItem>
              ) : organizations.length === 0 ? (
                <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
              ) : (
                organizations.map((org) => {
                  const isActive = org.id === props.activeOrganizationId;
                  return (
                    <DropdownMenuItem
                      key={org.id}
                      disabled={isActive}
                      onClick={() => void props.onSwitchOrganization?.(org.id)}
                      className="text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate">{org.name}</span>
                      {isActive && <CheckMark />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {props.onCreateOrganization && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-xs"
                    onSelect={(event) => {
                      event.preventDefault();
                      props.onCreateOrganization?.();
                    }}
                  >
                    Create organization
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <div className="px-2 py-1.5 text-xs text-popover-foreground">
            <span className="min-w-0 flex-1 truncate">No organization</span>
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Signed in as
        </DropdownMenuLabel>
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-popover-foreground">
          <AccountAvatar url={user.avatarUrl} name={user.name} email={user.email} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{user.name ?? user.email}</p>
            {user.name && <p className="truncate text-muted-foreground">{user.email}</p>}
          </div>
        </div>
        {(props.settingsLink || props.onSignOut) && <DropdownMenuSeparator />}
        {props.settingsLink && (
          <DropdownMenuItem asChild className="text-xs">
            {props.settingsLink}
          </DropdownMenuItem>
        )}
        {props.onSignOut && (
          <>
            <DropdownMenuItem
              className="text-xs text-destructive focus:text-destructive"
              onClick={() => void props.onSignOut?.()}
            >
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
