-- The model vendor per agent (spec section 13, decision 2; D54, D56). '' means the installation default
-- (LLM_PROVIDER); model "echo" always selects the echo provider.
ALTER TABLE runtime.agents ADD COLUMN provider text NOT NULL DEFAULT '' CHECK (provider IN ('', 'anthropic', 'google', 'echo'));
