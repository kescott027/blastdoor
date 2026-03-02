export function registerManagerUserRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    normalizeUserFilter,
    buildManagedUserList,
    validateManagedUsername,
    validateManagedUsernameForActions,
    normalizeString,
    normalizeUserStatus,
    sanitizeLongText,
    sanitizeEmail,
    withBlastdoorApi,
    createPasswordHash,
    createEmailService,
    loadEmailConfigFromEnv,
    resolveGatewayBaseUrl,
  } = options;

  registerApiGet("/users", async (req, res) => {
    try {
      const view = normalizeUserFilter(req.query?.view, "active");
      const payload = await buildManagedUserList({ filter: view });
      res.json({
        ok: true,
        ...payload,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/create", async (req, res) => {
    try {
      const username = validateManagedUsername(req.body?.username);
      const password = normalizeString(req.body?.password, "");
      if (password.length < 12) {
        throw new Error("Password must be at least 12 characters.");
      }
      const status = normalizeUserStatus(req.body?.status, "active");
      const friendlyName = sanitizeLongText(req.body?.friendlyName, 160);
      const email = sanitizeEmail(req.body?.email);
      const displayInfo = sanitizeLongText(req.body?.displayInfo, 2048);
      const notes = sanitizeLongText(req.body?.notes, 4096);

      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        if (users.some((entry) => entry.username === username)) {
          throw new Error("User already exists.");
        }

        await blastdoorApi.upsertCredentialUser({
          username,
          passwordHash: createPasswordHash(password),
          totpSecret: null,
          disabled: status !== "active",
        });
        await blastdoorApi.upsertUserProfile({
          username,
          friendlyName,
          email,
          status,
          displayInfo,
          notes,
        });
      });

      const listPayload = await buildManagedUserList({ filter: "all" });
      const createdUser = listPayload.users.find((entry) => entry.username === username) || null;
      res.json({
        ok: true,
        user: createdUser,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/update", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const password = normalizeString(req.body?.password, "");
      const status = normalizeUserStatus(req.body?.status, "active");
      const friendlyName = sanitizeLongText(req.body?.friendlyName, 160);
      const email = sanitizeEmail(req.body?.email);
      const displayInfo = sanitizeLongText(req.body?.displayInfo, 2048);
      const notes = sanitizeLongText(req.body?.notes, 4096);

      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        await blastdoorApi.upsertCredentialUser({
          username,
          passwordHash: password ? createPasswordHash(password) : existingUser.passwordHash,
          totpSecret: existingUser.totpSecret || null,
          disabled: status !== "active",
        });
        await blastdoorApi.upsertUserProfile({
          username,
          friendlyName,
          email,
          status,
          displayInfo,
          notes,
        });
      });

      const listPayload = await buildManagedUserList({ filter: "all" });
      const updatedUser = listPayload.users.find((entry) => entry.username === username) || null;
      res.json({
        ok: true,
        user: updatedUser,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/set-status", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const status = normalizeUserStatus(req.body?.status, "active");

      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        await blastdoorApi.upsertCredentialUser({
          username,
          passwordHash: existingUser.passwordHash,
          totpSecret: existingUser.totpSecret || null,
          disabled: status !== "active",
        });
        await blastdoorApi.upsertUserProfile({
          username,
          status,
        });
      });

      const listPayload = await buildManagedUserList({ filter: "all" });
      const updatedUser = listPayload.users.find((entry) => entry.username === username) || null;
      res.json({
        ok: true,
        user: updatedUser,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/reset-login-code", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const delivery = normalizeString(req.body?.delivery, "manual") || "manual";
      const ttlMinutes = Number.parseInt(normalizeString(req.body?.ttlMinutes, "30"), 10);

      let issuedCode = null;
      let profileEmail = "";
      let emailSent = false;
      let emailWarning = "";

      await withBlastdoorApi(async ({ configFromEnv, blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        issuedCode = await blastdoorApi.issueTemporaryLoginCode(username, { ttlMinutes, delivery });
        const profile = await blastdoorApi.getUserProfile(username);
        profileEmail = normalizeString(profile?.email, "");

        if (delivery !== "email") {
          return;
        }

        if (!profileEmail) {
          emailWarning = "User has no email set in profile. Copy this temporary code and deliver it securely.";
          return;
        }

        const emailService = createEmailService(loadEmailConfigFromEnv(configFromEnv));
        try {
          const baseUrl = resolveGatewayBaseUrl(configFromEnv);
          const result = await emailService.sendTemporaryLoginCode({
            to: profileEmail,
            username,
            code: issuedCode?.code || "",
            expiresAt: issuedCode?.expiresAt || "",
            loginUrlPath: `${baseUrl}/login?next=%2F`,
          });
          emailSent = Boolean(result?.ok);
          if (!result?.ok) {
            emailWarning = `Email dispatch unavailable: ${result?.reason || "provider not configured"}.`;
          }
        } finally {
          await emailService.close();
        }
      });

      res.json({
        ok: true,
        username,
        delivery,
        code: issuedCode?.code || "",
        expiresAt: issuedCode?.expiresAt || "",
        emailSent,
        emailTo: profileEmail,
        warning: delivery === "email" ? emailWarning : "",
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/invalidate-token", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      let profile = null;
      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        profile = await blastdoorApi.invalidateUserSessions(username);
      });

      res.json({
        ok: true,
        username,
        sessionVersion: profile?.sessionVersion || 1,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
