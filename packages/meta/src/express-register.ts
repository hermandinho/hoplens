// `node -r hoplens/express/register` or `node --import hoplens/express/register`. Stays a require of
// @hoplens/express/register (external in tsup.config) so the gate runs before anything loads core.
import "@hoplens/express/register";
