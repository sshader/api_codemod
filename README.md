This is a best effort codemod for updating [Convex](https://www.npmjs.com/package/convex) projects from using the
`useQuery("messages:list")` syntax to `useQuery(api.messages.list)` introduced in version 0.17.0.

Since this codemod may make mistakes, make sure you're in a clean git state (i.e. no important staged changes)
before running so it's easy to revert.

After updating to Convex version 0.17.0, update codegen in your project by running the following:

```
npx convex codegen --typecheck=disable
```

To run this codemod:

```
git clone https://github.com/sshader/api_codemod.git
cd api_codemod
npm install
npx ts-node index.ts --project <path to project>
```

(e.g. `npx ts-node index.ts --project ~/my-app`)

Afterwards, check the changes made since there may be mistakes / missed cases.
