"use client";

import { useSession, signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

export function SettingsForm() {
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const router = useRouter();

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center mb-8">
          <button
            onClick={() => router.back()}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h1 className="ml-4 text-3xl font-extrabold text-gray-900 dark:text-white">Settings</h1>
        </div>
        <div className="space-y-8">
          <div className="bg-white dark:bg-gray-800 shadow sm:rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">
                Appearance
              </h3>
              <div className="mt-2 max-w-xl text-sm text-gray-500 dark:text-gray-400">
                <p>Customize the look and feel of the application.</p>
              </div>
              <div className="mt-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Theme</span>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setTheme("light")}
                      className={`px-3 py-1 rounded-md text-sm font-medium ${
                        theme === "light"
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      }`}
                    >
                      Light
                    </button>
                    <button
                      onClick={() => setTheme("dark")}
                      className={`px-3 py-1 rounded-md text-sm font-medium ${
                        theme === "dark"
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      }`}
                    >
                      Dark
                    </button>
                    <button
                      onClick={() => setTheme("system")}
                      className={`px-3 py-1 rounded-md text-sm font-medium ${
                        theme === "system"
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      }`}
                    >
                      System
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 shadow sm:rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">
                User Profile
              </h3>
              <div className="mt-2 max-w-xl text-sm text-gray-500 dark:text-gray-400">
                <p>You are signed in as {session?.user?.email}</p>
              </div>
              <div className="mt-5">
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
