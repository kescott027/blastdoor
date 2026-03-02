export function registerManagerThemeRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    withBlastdoorApi,
    mapThemeForClient,
    validateThemeAssetSelection,
    parseBooleanLikeBody,
    createThemeId,
    normalizeString,
    normalizeThemeName,
    defaultThemeId,
  } = options;

  registerApiGet("/themes", async (_req, res) => {
    try {
      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        return { store, assets };
      });
      res.json({
        ok: true,
        activeThemeId: payload.store.activeThemeId || "",
        themes: (payload.store.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/create", async (req, res) => {
    try {
      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const assets = await blastdoorApi.listThemeAssets();
        const validated = validateThemeAssetSelection(
          {
            themeName: req.body?.name,
            logoPath: req.body?.logoPath,
            closedBackgroundPath: req.body?.closedBackgroundPath,
            openBackgroundPath: req.body?.openBackgroundPath,
            loginBoxWidthPercent: req.body?.loginBoxWidthPercent,
            loginBoxHeightPercent: req.body?.loginBoxHeightPercent,
            loginBoxPosXPercent: req.body?.loginBoxPosXPercent,
            loginBoxPosYPercent: req.body?.loginBoxPosYPercent,
            loginBoxOpacityPercent: req.body?.loginBoxOpacityPercent,
            loginBoxHoverOpacityPercent: req.body?.loginBoxHoverOpacityPercent,
            logoSizePercent: req.body?.logoSizePercent,
            logoOffsetXPercent: req.body?.logoOffsetXPercent,
            logoOffsetYPercent: req.body?.logoOffsetYPercent,
            backgroundZoomPercent: req.body?.backgroundZoomPercent,
            loginBoxMode: req.body?.loginBoxMode,
          },
          assets,
        );
        const makeActive = parseBooleanLikeBody(req.body?.makeActive);

        const store = await blastdoorApi.readThemeStore();
        const existingIds = new Set((store.themes || []).map((theme) => theme.id));
        const id = createThemeId(validated.name, existingIds);
        const now = new Date().toISOString();
        const createdTheme = {
          id,
          name: validated.name,
          logoPath: validated.logoPath,
          closedBackgroundPath: validated.closedBackgroundPath,
          openBackgroundPath: validated.openBackgroundPath,
          loginBoxWidthPercent: validated.loginBoxWidthPercent,
          loginBoxHeightPercent: validated.loginBoxHeightPercent,
          loginBoxPosXPercent: validated.loginBoxPosXPercent,
          loginBoxPosYPercent: validated.loginBoxPosYPercent,
          loginBoxOpacityPercent: validated.loginBoxOpacityPercent,
          loginBoxHoverOpacityPercent: validated.loginBoxHoverOpacityPercent,
          logoSizePercent: validated.logoSizePercent,
          logoOffsetXPercent: validated.logoOffsetXPercent,
          logoOffsetYPercent: validated.logoOffsetYPercent,
          backgroundZoomPercent: validated.backgroundZoomPercent,
          loginBoxMode: validated.loginBoxMode,
          createdAt: now,
          updatedAt: now,
        };

        const nextThemes = [...(store.themes || []), createdTheme];
        const nextActiveThemeId = makeActive || !store.activeThemeId ? createdTheme.id : store.activeThemeId;
        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: nextActiveThemeId,
          themes: nextThemes,
        });
        return { assets, createdTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        createdTheme: mapThemeForClient(payload.createdTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/update", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const assets = await blastdoorApi.listThemeAssets();
        const validated = validateThemeAssetSelection(
          {
            themeName: req.body?.name,
            logoPath: req.body?.logoPath,
            closedBackgroundPath: req.body?.closedBackgroundPath,
            openBackgroundPath: req.body?.openBackgroundPath,
            loginBoxWidthPercent: req.body?.loginBoxWidthPercent,
            loginBoxHeightPercent: req.body?.loginBoxHeightPercent,
            loginBoxPosXPercent: req.body?.loginBoxPosXPercent,
            loginBoxPosYPercent: req.body?.loginBoxPosYPercent,
            loginBoxOpacityPercent: req.body?.loginBoxOpacityPercent,
            loginBoxHoverOpacityPercent: req.body?.loginBoxHoverOpacityPercent,
            logoSizePercent: req.body?.logoSizePercent,
            logoOffsetXPercent: req.body?.logoOffsetXPercent,
            logoOffsetYPercent: req.body?.logoOffsetYPercent,
            backgroundZoomPercent: req.body?.backgroundZoomPercent,
            loginBoxMode: req.body?.loginBoxMode,
          },
          assets,
          { requireClosedBackground: false },
        );
        const makeActive = parseBooleanLikeBody(req.body?.makeActive);

        const store = await blastdoorApi.readThemeStore();
        const themeIndex = (store.themes || []).findIndex((theme) => theme.id === themeId);
        if (themeIndex < 0) {
          throw new Error("Requested theme was not found.");
        }

        const existingTheme = store.themes[themeIndex];
        const now = new Date().toISOString();
        const updatedTheme = {
          ...existingTheme,
          name: validated.name,
          logoPath: validated.logoPath,
          closedBackgroundPath: validated.closedBackgroundPath,
          openBackgroundPath: validated.openBackgroundPath,
          loginBoxWidthPercent: validated.loginBoxWidthPercent,
          loginBoxHeightPercent: validated.loginBoxHeightPercent,
          loginBoxPosXPercent: validated.loginBoxPosXPercent,
          loginBoxPosYPercent: validated.loginBoxPosYPercent,
          loginBoxOpacityPercent: validated.loginBoxOpacityPercent,
          loginBoxHoverOpacityPercent: validated.loginBoxHoverOpacityPercent,
          logoSizePercent: validated.logoSizePercent,
          logoOffsetXPercent: validated.logoOffsetXPercent,
          logoOffsetYPercent: validated.logoOffsetYPercent,
          backgroundZoomPercent: validated.backgroundZoomPercent,
          loginBoxMode: validated.loginBoxMode,
          updatedAt: now,
        };

        const nextThemes = [...(store.themes || [])];
        nextThemes[themeIndex] = updatedTheme;
        const nextActiveThemeId = makeActive ? themeId : store.activeThemeId;
        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: nextActiveThemeId,
          themes: nextThemes,
        });
        return { assets, updatedTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        updatedTheme: mapThemeForClient(payload.updatedTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/rename", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }

      const name = normalizeThemeName(req.body?.name);
      if (!name) {
        throw new Error("Theme name is required.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const themeIndex = (store.themes || []).findIndex((theme) => theme.id === themeId);
        if (themeIndex < 0) {
          throw new Error("Requested theme was not found.");
        }

        const existingTheme = store.themes[themeIndex];
        const updatedTheme = {
          ...existingTheme,
          name,
          updatedAt: new Date().toISOString(),
        };

        const nextThemes = [...(store.themes || [])];
        nextThemes[themeIndex] = updatedTheme;
        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: store.activeThemeId,
          themes: nextThemes,
        });
        return { assets, updatedTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        updatedTheme: mapThemeForClient(payload.updatedTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/delete", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }
      if (themeId === defaultThemeId) {
        throw new Error("Default theme cannot be deleted.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const existingTheme = (store.themes || []).find((theme) => theme.id === themeId);
        if (!existingTheme) {
          throw new Error("Requested theme was not found.");
        }

        const nextThemes = (store.themes || []).filter((theme) => theme.id !== themeId);
        const nextActiveThemeId =
          store.activeThemeId === themeId
            ? nextThemes[0]?.id || defaultThemeId
            : store.activeThemeId;

        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: nextActiveThemeId,
          themes: nextThemes,
        });
        return { assets, updatedStore };
      });

      res.json({
        ok: true,
        deletedThemeId: themeId,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/apply", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const selectedTheme = (store.themes || []).find((theme) => theme.id === themeId);
        if (!selectedTheme) {
          throw new Error("Requested theme was not found.");
        }

        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: themeId,
          themes: store.themes || [],
        });
        return { assets, selectedTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        activeTheme: mapThemeForClient(payload.selectedTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
