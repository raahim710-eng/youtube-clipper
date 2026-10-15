import { redirect } from "next/navigation";

/** The app has no public home page; the proxy sends signed-out visitors to /login. */
export default function Home() {
  redirect("/dashboard");
}
