import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/linkedin/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-label-sm transition focus-visible:outline-none focus-visible:shadow-button-important-focus disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary-base text-primary-contrast shadow-regular-xs hover:bg-primary-darker",
        destructive: "bg-error-base text-static-white shadow-regular-xs hover:bg-error-dark",
        outline: "bg-bg-white-0 text-text-sub-600 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50 hover:text-text-strong-950",
        secondary: "bg-bg-weak-50 text-text-strong-950 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-soft-200",
        ghost: "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950",
        link: "text-primary-base underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
