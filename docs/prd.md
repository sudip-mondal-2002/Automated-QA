# QA Shop — product requirements

## REQ-1 Authentication
Registered users sign in with username and password. Invalid
credentials show an error and do not create a session.

## REQ-2 Cart
Users can view items in their cart with quantity and line total.
An empty cart shows an empty state, not an error.

## REQ-3 Checkout
Users complete a purchase with a saved or newly entered card.
An invalid or blank card number is rejected with a field-level
validation message and no order is created.

## REQ-4 Promo codes
Users can apply a promo code at checkout to reduce the order
total. Invalid codes are rejected without clearing the cart.

## REQ-5 Order confirmation
A completed order shows a confirmation page with an order
number, and appears in the user's order history.
