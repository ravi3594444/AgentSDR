// AlignUI Avatar v0.0.0
//
// Trimmed to the parts this app uses: initials avatars with an optional
// image and status dot. Upstream also ships BrandLogo/Notification and
// illustrated user/company placeholders — add them from the docs if needed.

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { cn } from '@/utils/cn';
import { recursiveCloneChildren } from '@/utils/recursive-clone-children';
import { tv, type VariantProps } from '@/utils/tv';

export const AVATAR_ROOT_NAME = 'AvatarRoot';
const AVATAR_IMAGE_NAME = 'AvatarImage';
const AVATAR_INDICATOR_NAME = 'AvatarIndicator';
const AVATAR_STATUS_NAME = 'AvatarStatus';

export const avatarVariants = tv({
  slots: {
    root: [
      'relative flex shrink-0 items-center justify-center rounded-full',
      'select-none text-center uppercase',
    ],
    image: 'size-full rounded-full object-cover',
    indicator:
      'absolute flex size-8 items-center justify-center drop-shadow-[0_2px_4px_#1b1c1d0a]',
  },
  variants: {
    size: {
      '80': { root: 'size-20 text-title-h5' },
      '72': { root: 'size-[72px] text-title-h5' },
      '64': { root: 'size-16 text-title-h5' },
      '56': { root: 'size-14 text-label-lg' },
      '48': { root: 'size-12 text-label-lg' },
      '40': { root: 'size-10 text-label-md' },
      '32': { root: 'size-8 text-label-sm' },
      '24': { root: 'size-6 text-label-xs' },
      '20': { root: 'size-5 text-label-2xs' },
    },
    color: {
      gray: { root: 'bg-bg-soft-200 text-text-strong-950' },
      yellow: { root: 'bg-yellow-200 text-yellow-950' },
      blue: { root: 'bg-blue-200 text-blue-950' },
      sky: { root: 'bg-sky-200 text-sky-950' },
      purple: { root: 'bg-purple-200 text-purple-950' },
      red: { root: 'bg-red-200 text-red-950' },
    },
  },
  compoundVariants: [
    { size: ['80', '72'], class: { indicator: '-right-2' } },
    { size: '64', class: { indicator: '-right-2 scale-[.875]' } },
    { size: '56', class: { indicator: '-right-1.5 scale-75' } },
    { size: '48', class: { indicator: '-right-1.5 scale-[.625]' } },
    { size: '40', class: { indicator: '-right-1.5 scale-[.5625]' } },
    { size: '32', class: { indicator: '-right-1.5 scale-50' } },
    { size: '24', class: { indicator: '-right-1 scale-[.375]' } },
    { size: '20', class: { indicator: '-right-1 scale-[.3125]' } },
  ],
  defaultVariants: {
    size: '80',
    color: 'gray',
  },
});

type AvatarSharedProps = VariantProps<typeof avatarVariants>;

export type AvatarRootProps = VariantProps<typeof avatarVariants> &
  React.HTMLAttributes<HTMLDivElement> & {
    asChild?: boolean;
  };

const AvatarRoot = React.forwardRef<HTMLDivElement, AvatarRootProps>(
  ({ asChild, children, size, color, className, ...rest }, forwardedRef) => {
    const uniqueId = React.useId();
    const Component = asChild ? Slot : 'div';
    const { root } = avatarVariants({ size, color });

    const sharedProps: AvatarSharedProps = { size, color };

    const extendedChildren = recursiveCloneChildren(
      children as React.ReactElement[],
      sharedProps,
      [AVATAR_IMAGE_NAME, AVATAR_INDICATOR_NAME],
      uniqueId,
      asChild,
    );

    return (
      <Component
        ref={forwardedRef}
        className={root({ class: className })}
        {...rest}
      >
        {extendedChildren}
      </Component>
    );
  },
);
AvatarRoot.displayName = AVATAR_ROOT_NAME;

type AvatarImageProps = AvatarSharedProps &
  Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'color'> & {
    asChild?: boolean;
  };

const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(
  ({ asChild, className, size, color, ...rest }, forwardedRef) => {
    const Component = asChild ? Slot : 'img';
    const { image } = avatarVariants({ size, color });

    return (
      <Component
        ref={forwardedRef}
        className={image({ class: className })}
        {...rest}
      />
    );
  },
);
AvatarImage.displayName = AVATAR_IMAGE_NAME;

function AvatarIndicator({
  size,
  color,
  className,
  position = 'bottom',
  ...rest
}: AvatarSharedProps &
  React.HTMLAttributes<HTMLDivElement> & {
    position?: 'top' | 'bottom';
  }) {
  const { indicator } = avatarVariants({ size, color });

  return (
    <div
      className={cn(indicator({ class: className }), {
        'top-0 origin-top-right': position === 'top',
        'bottom-0 origin-bottom-right': position === 'bottom',
      })}
      {...rest}
    />
  );
}
AvatarIndicator.displayName = AVATAR_INDICATOR_NAME;

export const avatarStatusVariants = tv({
  base: 'box-content size-3 rounded-full border-4 border-bg-white-0',
  variants: {
    status: {
      online: 'bg-success-base',
      offline: 'bg-faded-base',
      busy: 'bg-error-base',
      away: 'bg-away-base',
    },
  },
  defaultVariants: {
    status: 'online',
  },
});

function AvatarStatus({
  status,
  className,
  ...rest
}: VariantProps<typeof avatarStatusVariants> &
  React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={avatarStatusVariants({ status, class: className })}
      {...rest}
    />
  );
}
AvatarStatus.displayName = AVATAR_STATUS_NAME;

export {
  AvatarRoot as Root,
  AvatarImage as Image,
  AvatarIndicator as Indicator,
  AvatarStatus as Status,
};
