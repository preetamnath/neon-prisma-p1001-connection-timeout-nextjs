# Neon database P1001 connection timeout issue using Prisma ORM and Nextjs
A fix for Neon database P1001 connection timeout error when using Prisma ORM in a Nextjs app deployed on Vercel.

### Find the code here:
https://github.com/preetamnath/neon-prisma-p1001-connection-timeout-nextjs/blob/b2014bcb306c4bdca9e83acf4666eb50eeafd76e/lib/prisma.ts

## Problem description:

Neon postgres has a cold start problem.

It's not a surprise, given that they are a "serverless" pg platform.

But the cold start issue is quite annoying. It happens when compute is suspended, and a user of the app triggers a db query.

I use Prisma's ORM. And the way to specify to Prisma client to wait longer before connection timeout is to add this parameter to your "DATABSE_URL" string

?connect_timeout=5

Neon's documentation says their db is back usually within 5 seconds. So increasing ?connect_timeout=10 should work, right?

It did not solve the problem for me. I would still get the same error (error text from Neon's documentation):

Error: P1001: Can't reach database server at `database_url`:`5432`Please make sure your database server is running at `database_url`:`5432`.

Finally, I had to write this wrapper in my lib/prisma.ts client initialization code to handle retries. This seems to be working (for now).

Unanswered questions:
- Even a single retry on the default 5 second connect_timeout works, which is strange because if that's true, why did connect_timeout 10 not work?
- Am I doing something wrong or missing something due to which ?connect_timeout=10 did not solve the problem?

My tech stack is - Nextjs 15 app router hosted on Vercel, Prisma ORM, Neon database

**This post was originally a tweet. You can reply there if you have suggestions:**
https://x.com/hipreetam93/status/1951152075410219056
