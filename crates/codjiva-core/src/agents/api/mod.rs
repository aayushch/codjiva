//! API-key mode: the app runs the agent loop itself against a model provider's
//! API.

pub mod anthropic;
pub mod backend;
pub mod catalog;
pub mod google;
pub mod keys;
pub mod openai;
pub mod provider;
#[cfg(test)]
pub mod testing;
pub mod tools;
