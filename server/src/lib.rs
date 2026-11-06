//! Native services used by the host, without transport or feature logic.
//! Keeping storage behind a library lets future JS calls retain one transaction
//! across awaits without exposing a SQL or auto-committing client escape hatch.

pub mod data;
