import { Group, co, z } from "jazz-tools";

const CaloricRoot = co.map({});

const CaloricProfile = co.profile({
  name: z.string(),
  email: z.string(),
});

export const CaloricAccount = co
  .account({
    root: CaloricRoot,
    profile: CaloricProfile,
  })
  .withMigration(async (account, creationProps?: { name: string }) => {
    if (!account.$jazz.has("root")) {
      account.$jazz.set("root", {});
    }

    if (!account.$jazz.has("profile")) {
      const profileGroup = Group.create();
      profileGroup.makePublic();

      account.$jazz.set(
        "profile",
        CaloricProfile.create(
          {
            name: creationProps?.name?.trim() || "New user",
            email: "",
          },
          profileGroup,
        ),
      );
      return;
    }

    const { profile } = await account.$jazz.ensureLoaded({
      resolve: { profile: true },
    });

    if (!profile.$jazz.has("name")) {
      profile.$jazz.set("name", creationProps?.name?.trim() || "New user");
    }

    if (!profile.$jazz.has("email")) {
      profile.$jazz.set("email", "");
    }
  });
