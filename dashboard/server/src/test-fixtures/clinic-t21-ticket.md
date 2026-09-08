Build a polished, responsive web app for booking a fictional clinic appointment. Implement a three-step wizard:

1. Choose one of exactly three appointment types.
2. Choose a date and one of exactly four predefined time slots.
3. Review and confirm the booking.

Include Back and Continue controls, a visible progress indicator, inline validation, a confirmation screen, and a Book another appointment reset action. Back must preserve valid selections. Reset must return to Step 1 and clear selections, validation messages, and the previous confirmation. Keep all data local and deterministic; do not use authentication, payments, databases, maps, email, calendars, analytics, or external APIs.

Accessibility requirements: full keyboard operation, visible focus states, semantic form controls, associated labels, accessible error messages that do not rely on color alone, logical heading structure, and sufficient color contrast. After a validation failure, move focus to the first error or invalid field. After changing steps, move focus predictably to the new step heading or first meaningful control.

The layout must work at 375px and desktop widths with no horizontal scrolling or clipped controls. Resizing mid-flow must preserve the current step and valid selections.

Deliver a static app or local web server with clear run instructions. All routes and interactions must work after a fresh start.