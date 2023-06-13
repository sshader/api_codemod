This is a codemod for updating [Convex](https://www.npmjs.com/package/convex) projects from using the
`useQuery("messages:list")` syntax to `useQuery(api.messages.list)` introduced in version 0.17.0.

To run:

Make sure you're in a clean git state.

```
git clone https://github.com/sshader/api_codemod.git
cd api_codemod
npm install
npx ts-node index.ts --project <path to project>
```

(e.g. `npx ts-node index.ts --project ~/my-app`)
